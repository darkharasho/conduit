use std::collections::{HashMap, HashSet};
use crate::config::{Action, Chord, CompiledConfig, HoldAction};
use crate::event::{Event, Key, KeyState};

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
enum HeldEntry { OutKey(Key), OutChord(Chord), LayerHeld(u8), Swallowed }

/// A held entry with the source device slot that produced it.
/// `source` is `None` when no device section matched (global mapping only).
#[derive(Clone, Copy, Debug)]
struct Held {
    entry: HeldEntry,
    source: Option<u16>,
}

impl Held {
    fn new(entry: HeldEntry, source: Option<u16>) -> Self {
        Self { entry, source }
    }
}

struct Pending {
    phys: Key,
    tap: Key,
    hold: HoldAction,
    press_time_us: u64,
    deadline_us: u64,
    source: Option<u16>,
}

enum Resolution {
    Tap { release_time_us: u64 },
    Hold,
}

pub struct Engine {
    cfg: CompiledConfig,
    profile_idx: usize,
    active_layers: Vec<u8>,     // stack; index 0 is always base layer 0 (Task 5)
    held: HashMap<Key, Held>,
    out: Vec<Event>,            // reused output buffer
    pending: Option<Pending>,
    /// Events buffered behind a pending tap-hold, with their device slot so
    /// replay resolves through the same tables as original delivery.
    buffer: Vec<(Event, Option<u16>)>,
    // Panic chord / suspend state
    suspended: bool,
    chord_down: HashSet<Key>,
    chord_armed: bool,
}

impl Engine {
    pub fn new(cfg: CompiledConfig) -> Self {
        let profile_idx = cfg.default_idx;
        Engine {
            cfg,
            profile_idx,
            active_layers: vec![0],
            held: HashMap::new(),
            out: Vec::with_capacity(16),
            pending: None,
            buffer: Vec::new(),
            suspended: false,
            chord_down: HashSet::new(),
            chord_armed: true,
        }
    }

    pub fn handle(&mut self, ev: Event) -> &[Event] {
        self.handle_on(ev, None)
    }

    /// Handle an event from a specific device slot (see
    /// `CompiledConfig::device_selectors`). `None` = no device section
    /// matches the source; only global tables apply.
    pub fn handle_on(&mut self, ev: Event, slot: Option<u16>) -> &[Event] {
        self.out.clear();
        self.process(ev, slot);
        &self.out
    }

    pub fn tick(&mut self, now_us: u64) -> &[Event] {
        self.out.clear();
        while self.pending.as_ref().map_or(false, |p| p.deadline_us <= now_us) {
            self.resolve(Resolution::Hold);
        }
        &self.out
    }

    pub fn next_deadline_us(&self) -> Option<u64> {
        self.pending.as_ref().map(|p| p.deadline_us)
    }

    fn lookup(&self, key: Key, slot: Option<u16>) -> Action {
        let profile = &self.cfg.profiles[self.profile_idx];
        for &layer in self.active_layers.iter().rev() {
            // Device shadow table first (out-of-range slots fall through).
            if let Some(s) = slot {
                if let Some(Some(dev)) = profile.device_layers.get(s as usize) {
                    if let Some(a) = dev[layer as usize][key.0 as usize] {
                        return a;
                    }
                }
            }
            if let Some(a) = profile.layers[layer as usize][key.0 as usize] {
                return a;
            }
        }
        Action::Passthrough
    }

    fn resolve(&mut self, how: Resolution) {
        let p = self.pending.take().expect("resolve without pending");
        match how {
            Resolution::Tap { release_time_us } => {
                self.out.push(Event { key: p.tap, state: KeyState::Press, time_us: p.press_time_us });
                self.out.push(Event { key: p.tap, state: KeyState::Release, time_us: release_time_us });
            }
            Resolution::Hold => match p.hold {
                HoldAction::Key(k) => {
                    self.held.insert(p.phys, Held::new(HeldEntry::OutKey(k), p.source));
                    self.out.push(Event { key: k, state: KeyState::Press, time_us: p.press_time_us });
                }
                HoldAction::Layer(l) => {
                    self.active_layers.push(l);
                    self.held.insert(p.phys, Held::new(HeldEntry::LayerHeld(l), p.source));
                }
            },
        }
        // Drain buffered events through normal processing.
        // A buffered TapHold press will re-establish pending; subsequent events
        // re-buffer behind it via the pending check at the top of process().
        for (ev, slot) in std::mem::take(&mut self.buffer) {
            self.process(ev, slot);
        }
    }

    fn process(&mut self, ev: Event, slot: Option<u16>) {
        // ── Panic chord tracking (always active, even while suspended) ──────────
        let chord_keys = self.cfg.settings.panic_chord.clone();
        if !chord_keys.is_empty() {
            if chord_keys.contains(&ev.key) {
                match ev.state {
                    KeyState::Press => {
                        self.chord_down.insert(ev.key);
                    }
                    KeyState::Release | KeyState::Repeat => {
                        if ev.state == KeyState::Release {
                            self.chord_down.remove(&ev.key);
                            // Re-arm when any chord key is released
                            self.chord_armed = true;
                        }
                    }
                }
                // Check if all chord keys are down and chord is armed
                let all_down = chord_keys.iter().all(|k| self.chord_down.contains(k));
                if all_down && self.chord_armed {
                    self.chord_armed = false;
                    if self.suspended {
                        self.resume();
                    } else {
                        // Suspend: emit flush events into current out buffer (do NOT clear it)
                        self.do_suspend();
                    }
                }
            }
        }

        // While suspended: raw passthrough only (chord keys already handled above)
        if self.suspended {
            self.out.push(ev);
            return;
        }

        // Handle pending tap-hold state: buffer events or resolve
        if let Some(pending_phys) = self.pending.as_ref().map(|p| p.phys) {
            if ev.key == pending_phys && ev.state == KeyState::Release {
                // Pending key released: resolve as tap. First-arrival-wins policy:
                // if release arrives before any tick() call (even if timestamp is past the
                // deadline), we treat it as tap. This is intentional QMK-style behavior.
                self.resolve(Resolution::Tap { release_time_us: ev.time_us });
                return;
            }
            if ev.key == pending_phys {
                // swallow repeats of the pending key
                return;
            }
            self.buffer.push((ev, slot));
            // permissive hold: same key pressed AND released inside the buffer?
            let hold_now = self.buffer.iter().any(|(b, _)| {
                b.state == KeyState::Release
                    && self
                        .buffer
                        .iter()
                        .any(|(b2, _)| b2.key == b.key && b2.state == KeyState::Press)
            });
            if hold_now {
                self.resolve(Resolution::Hold);
            }
            return;
        }

        match ev.state {
            KeyState::Press => match self.lookup(ev.key, slot) {
                Action::Key(out) => {
                    self.held.insert(ev.key, Held::new(HeldEntry::OutKey(out), slot));
                    self.out.push(Event { key: out, ..ev });
                }
                Action::Passthrough => {
                    self.held.insert(ev.key, Held::new(HeldEntry::OutKey(ev.key), slot));
                    self.out.push(ev);
                }
                Action::Disabled => { self.held.insert(ev.key, Held::new(HeldEntry::Swallowed, slot)); }
                Action::TapHold { tap, hold, timeout_us } => {
                    self.pending = Some(Pending {
                        phys: ev.key,
                        tap,
                        hold,
                        press_time_us: ev.time_us,
                        deadline_us: ev.time_us + timeout_us,
                        source: slot,
                    });
                }
                Action::LayerWhileHeld(n) => {
                    self.active_layers.push(n);
                    self.held.insert(ev.key, Held::new(HeldEntry::LayerHeld(n), slot));
                }
                Action::LayerToggle(n) => {
                    if let Some(pos) = self.active_layers.iter().rposition(|&l| l == n) {
                        // layer 0 (base) can never be popped
                        if pos != 0 { self.active_layers.remove(pos); }
                    } else {
                        self.active_layers.push(n);
                    }
                    self.held.insert(ev.key, Held::new(HeldEntry::Swallowed, slot));
                }
                Action::Chord(ch) => {
                    self.held.insert(ev.key, Held::new(HeldEntry::OutChord(ch), slot));
                    for k in ch.keys() {
                        self.out.push(Event { key: *k, state: KeyState::Press, time_us: ev.time_us });
                    }
                }
            },
            KeyState::Release => match self.held.remove(&ev.key).map(|h| h.entry) {
                Some(HeldEntry::OutKey(out)) => self.out.push(Event { key: out, ..ev }),
                Some(HeldEntry::OutChord(ch)) => {
                    for k in ch.keys().iter().rev() {
                        self.out.push(Event { key: *k, state: KeyState::Release, time_us: ev.time_us });
                    }
                }
                Some(HeldEntry::Swallowed) => {}
                Some(HeldEntry::LayerHeld(l)) => {
                    // Pop the layer from active_layers (last occurrence); never pop pos 0 (base layer)
                    if let Some(pos) = self.active_layers.iter().rposition(|&x| x == l) {
                        if pos != 0 {
                            self.active_layers.remove(pos);
                        }
                    }
                }
                None => self.out.push(ev),
            },
            KeyState::Repeat => match self.held.get(&ev.key).map(|h| h.entry) {
                Some(HeldEntry::OutKey(out)) => { self.out.push(Event { key: out, ..ev }); }
                Some(HeldEntry::OutChord(ch)) => {
                    let last = *ch.keys().last().expect("chord len >= 2");
                    self.out.push(Event { key: last, ..ev });
                }
                Some(_) => {}
                None => self.out.push(ev),
            },
        }
    }

    /// Internal: flush held keys as releases (appends to self.out, does NOT clear it).
    /// Also resolves any pending tap-hold as a tap, clears held/buffer, resets layers,
    /// and sets suspended = true.
    fn do_suspend(&mut self) {
        // Resolve pending as tap first (like swap_config does)
        if let Some(p) = self.pending.take() {
            self.out.push(Event { key: p.tap, state: KeyState::Press, time_us: p.press_time_us });
            self.out.push(Event { key: p.tap, state: KeyState::Release, time_us: p.press_time_us });
        }
        // Emit Release for every held OutKey or OutChord
        for (_phys, h) in &self.held {
            if let HeldEntry::OutKey(k) = h.entry {
                self.out.push(Event { key: k, state: KeyState::Release, time_us: 0 });
            } else if let HeldEntry::OutChord(ch) = h.entry {
                for k in ch.keys().iter().rev() {
                    self.out.push(Event { key: *k, state: KeyState::Release, time_us: 0 });
                }
            }
        }
        // Clear all state
        self.held.clear();
        self.buffer.clear();
        self.active_layers.clear();
        self.active_layers.push(0);
        self.suspended = true;
    }

    /// Flush held keys, clear engine state, and enter suspended mode.
    /// Returns the emitted flush events.
    /// Idempotent: calling again while already suspended returns an empty slice.
    pub fn suspend(&mut self) -> &[Event] {
        self.out.clear();
        if !self.suspended {
            self.do_suspend();
        }
        &self.out
    }

    /// Exit suspended mode (raw passthrough ends).
    pub fn resume(&mut self) {
        self.suspended = false;
    }

    /// Returns true if the engine is currently suspended.
    pub fn is_suspended(&self) -> bool {
        self.suspended
    }

    /// Emit releases for every output held by `source` and forget them.
    /// Chords release in reverse order. Called when a device disappears
    /// mid-hold so modifiers can't stick.
    pub fn release_device(&mut self, source: u16) -> &[Event] {
        self.out.clear();
        // A tap-hold pending on the vanished device can never receive its release;
        // resolve it as a tap now (press+release of the tap key) and drop any
        // buffered events that came from the same slot.
        if let Some(p) = &self.pending {
            if p.source == Some(source) {
                let p = self.pending.take().unwrap();
                self.out.push(Event { key: p.tap, state: KeyState::Press, time_us: p.press_time_us });
                self.out.push(Event { key: p.tap, state: KeyState::Release, time_us: p.press_time_us });
                // Replay buffered events from OTHER slots through normal processing;
                // drop the removed slot's. Mirror resolve()'s drain loop.
                let buffered = std::mem::take(&mut self.buffer);
                for (ev, slot) in buffered {
                    if slot != Some(source) { self.process(ev, slot); }
                }
            }
        }
        let keys: Vec<Key> = self.held.iter()
            .filter(|(_, h)| h.source == Some(source))
            .map(|(k, _)| *k)
            .collect();
        for k in keys {
            if let Some(h) = self.held.remove(&k) {
                match h.entry {
                    HeldEntry::OutKey(out) => {
                        self.out.push(Event { key: out, state: KeyState::Release, time_us: 0 });
                    }
                    HeldEntry::OutChord(ch) => {
                        for ck in ch.keys().iter().rev() {
                            self.out.push(Event { key: *ck, state: KeyState::Release, time_us: 0 });
                        }
                    }
                    HeldEntry::LayerHeld(l) => {
                        // Mirror the Release arm: pop last occurrence, never pop pos 0
                        if let Some(pos) = self.active_layers.iter().rposition(|&x| x == l) {
                            if pos != 0 {
                                self.active_layers.remove(pos);
                            }
                        }
                    }
                    HeldEntry::Swallowed => {}
                }
            }
        }
        &self.out
    }

    pub fn set_focus(&mut self, f: &crate::config::FocusFields) {
        let idx = self.cfg.profiles.iter().position(|p| {
            p.auto_switch && p.matcher.as_ref().map_or(true, |m| m.matches(f))
        }).unwrap_or(self.cfg.default_idx);
        if idx != self.profile_idx {
            self.profile_idx = idx;
            self.active_layers.clear();
            self.active_layers.push(0);
        }
    }

    pub fn swap_config(&mut self, cfg: CompiledConfig, f: &crate::config::FocusFields) -> &[Event] {
        self.out.clear();
        if let Some(p) = self.pending.take() {
            self.out.push(Event { key: p.tap, state: KeyState::Press, time_us: p.press_time_us });
            self.out.push(Event { key: p.tap, state: KeyState::Release, time_us: p.press_time_us });
        }
        let replay = std::mem::take(&mut self.buffer);
        self.cfg = cfg;
        self.profile_idx = self.cfg.default_idx;
        self.active_layers.clear();
        self.active_layers.push(0);
        self.set_focus(f);
        // Replay without slots: slot indices are defined by the config being
        // replaced, so they may point at the wrong (or no) section now.
        for (ev, _old_slot) in replay {
            self.process(ev, None);
        }
        &self.out
    }

    pub fn active_profile_name(&self) -> &str {
        &self.cfg.profiles[self.profile_idx].name
    }

    pub fn active_layer_names(&self) -> Vec<&str> {
        let profile = &self.cfg.profiles[self.profile_idx];
        self.active_layers.iter().map(|&i| profile.layer_names[i as usize].as_str()).collect()
    }

    #[cfg(test)]
    pub fn held_is_empty(&self) -> bool { self.held.is_empty() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::compile, event::*, keys};

    fn key(n: &str) -> Key { keys::from_name(n).unwrap() }
    fn press(n: &str, t: u64) -> Event { Event { key: key(n), state: KeyState::Press, time_us: t } }
    fn release(n: &str, t: u64) -> Event { Event { key: key(n), state: KeyState::Release, time_us: t } }
    fn engine(toml: &str) -> Engine { Engine::new(compile(toml).unwrap()) }

    const TWO_PROFILES: &str = r#"
        [profile.default.keys]
        a = "b"
        [profile.game]
        match = { class = "steam_app_123" }
        keys = { a = "passthrough" }
    "#;

    fn focus(class: &str) -> crate::config::FocusFields<'static> {
        crate::config::FocusFields {
            process: Box::leak(class.to_string().into_boxed_str()),
            class: Box::leak(class.to_string().into_boxed_str()),
            title: "",
        }
    }

    #[test]
    fn focus_switches_profile() {
        let mut e = engine(TWO_PROFILES);
        assert_eq!(e.handle(press("a", 0)), &[press("b", 0)]);
        e.handle(release("a", 1));
        e.set_focus(&focus("steam_app_123"));
        assert_eq!(e.active_profile_name(), "game");
        assert_eq!(e.handle(press("a", 10)), &[press("a", 10)]);
    }

    #[test]
    fn held_key_releases_under_old_mapping_after_switch() {
        let mut e = engine(TWO_PROFILES);
        e.handle(press("a", 0));                  // emitted b-press under default
        e.set_focus(&focus("steam_app_123"));     // switch mid-hold
        assert_eq!(e.handle(release("a", 10)), &[release("b", 10)]); // still pairs as b
    }

    #[test]
    fn unmatched_focus_falls_back_to_default() {
        let mut e = engine(TWO_PROFILES);
        e.set_focus(&focus("steam_app_123"));
        e.set_focus(&focus("kitty"));
        assert_eq!(e.active_profile_name(), "default");
    }

    #[test]
    fn simple_remap() {
        let mut e = engine("[profile.default.keys]\na = \"b\"");
        assert_eq!(e.handle(press("a", 0)), &[press("b", 0)]);
        assert_eq!(e.handle(release("a", 10)), &[release("b", 10)]);
    }

    #[test]
    fn unmapped_passes_through() {
        let mut e = engine("");
        assert_eq!(e.handle(press("q", 0)), &[press("q", 0)]);
    }

    #[test]
    fn disabled_swallows_press_and_release() {
        let mut e = engine("[profile.default.keys]\na = \"disabled\"");
        assert!(e.handle(press("a", 0)).is_empty());
        assert!(e.handle(release("a", 10)).is_empty());
    }

    #[test]
    fn mouse_button_remap() {
        let mut e = engine("[profile.default.keys]\nmouse4 = \"back\"");
        assert_eq!(e.handle(press("mouse4", 0)), &[press("back", 0)]);
    }

    #[test]
    fn release_pairs_with_press_mapping() {
        // Even if config semantics change between press and release (later tasks),
        // the held map must drive the release. Simulated here via two presses of
        // the same physical key: second press while held emits per held entry.
        let mut e = engine("[profile.default.keys]\na = \"b\"");
        e.handle(press("a", 0));
        assert_eq!(e.handle(release("a", 10)), &[release("b", 10)]);
        assert!(e.held_is_empty());
    }

    const TH: &str = "[profile.default.keys]\ncapslock = { tap = \"esc\", hold = \"leftctrl\" }";

    #[test]
    fn tap_when_released_before_timeout() {
        let mut e = engine(TH);
        assert!(e.handle(press("capslock", 0)).is_empty());
        assert_eq!(e.next_deadline_us(), Some(200_000));
        assert_eq!(e.handle(release("capslock", 150_000)),
                   &[press("esc", 0), release("esc", 150_000)]);
        assert_eq!(e.next_deadline_us(), None);
    }

    #[test]
    fn hold_when_timeout_fires() {
        let mut e = engine(TH);
        e.handle(press("capslock", 0));
        assert_eq!(e.tick(200_000), &[press("leftctrl", 0)]);
        assert_eq!(e.handle(release("capslock", 300_000)), &[release("leftctrl", 300_000)]);
    }

    #[test]
    fn permissive_hold_on_nested_tap() {
        // caps down, a down, a up  => hold resolves immediately: ctrl+a
        let mut e = engine(TH);
        e.handle(press("capslock", 0));
        assert!(e.handle(press("a", 50_000)).is_empty()); // buffered
        assert_eq!(e.handle(release("a", 90_000)),
                   &[press("leftctrl", 0), press("a", 50_000), release("a", 90_000)]);
    }

    #[test]
    fn buffered_events_replay_on_tap() {
        // caps down, a down, caps up before timeout => esc tap, then a press replays
        let mut e = engine(TH);
        e.handle(press("capslock", 0));
        e.handle(press("a", 50_000));
        assert_eq!(e.handle(release("capslock", 100_000)),
                   &[press("esc", 0), release("esc", 100_000), press("a", 50_000)]);
        // 'a' is now properly held; its release pairs normally
        assert_eq!(e.handle(release("a", 200_000)), &[release("a", 200_000)]);
    }

    #[test]
    fn nested_tap_holds_resolve_in_order() {
        // Two home-row mods: d=hold-shift, f=hold-ctrl. d down, f down, j down, j up
        // => d resolves hold (f pressed+? no—permissive needs press AND release of same key).
        // Sequence: d↓ f↓ j↓ j↑ : j↓+j↑ in d's buffer → d=hold(shift); replay f↓ (new pending),
        // j↓+j↑ re-buffer → f=hold(ctrl); replay j↓ j↑.
        let toml = "[profile.default.keys]\nd = { tap = \"d\", hold = \"leftshift\" }\nf = { tap = \"f\", hold = \"leftctrl\" }";
        let mut e = engine(toml);
        e.handle(press("d", 0));
        e.handle(press("f", 10_000));
        e.handle(press("j", 20_000));
        assert_eq!(e.handle(release("j", 30_000)),
                   &[press("leftshift", 0), press("leftctrl", 10_000),
                     press("j", 20_000), release("j", 30_000)]);
    }

    #[test]
    fn hold_to_layer() {
        let toml = "[profile.default.keys]\nf = { tap = \"f\", hold = \"layer:nav\" }\n[profile.default.layers.nav]\nh = \"left\"";
        let mut e = engine(toml);
        e.handle(press("f", 0));
        e.tick(200_000); // resolve hold → nav layer active (emits nothing)
        assert_eq!(e.handle(press("h", 250_000)), &[press("left", 250_000)]);
        e.handle(release("h", 260_000));
        e.handle(release("f", 300_000)); // pops layer
        assert_eq!(e.handle(press("h", 350_000)), &[press("h", 350_000)]);
    }

    #[test]
    fn chained_expired_tap_holds_resolve_in_one_tick() {
        // d and f are both tap-holds; both deadlines are past at tick time.
        let toml = "[profile.default.keys]\nd = { tap = \"d\", hold = \"leftshift\" }\nf = { tap = \"f\", hold = \"leftctrl\" }";
        let mut e = engine(toml);
        e.handle(press("d", 0));
        e.handle(press("f", 10_000)); // buffered behind d's pending
        // one tick well past both deadlines must resolve BOTH holds
        assert_eq!(e.tick(300_000), &[press("leftshift", 0), press("leftctrl", 10_000)]);
        assert_eq!(e.next_deadline_us(), None);
    }

    #[test]
    fn late_release_before_tick_still_resolves_tap() {
        let mut e = engine(TH); // TH const already exists (capslock tap esc / hold leftctrl)
        e.handle(press("capslock", 0));
        // release timestamp is past the 200ms deadline, but no tick() has fired:
        assert_eq!(e.handle(release("capslock", 250_000)),
                   &[press("esc", 0), release("esc", 250_000)]);
    }

    const LAYERS: &str = "[profile.default.keys]\nspace = \"layer:sym\"\ntab = \"disabled\"\n[profile.default.layers.sym]\nj = \"1\"\nk = \"2\"";

    #[test]
    fn layer_toggle_switches_and_back() {
        let mut e = engine(LAYERS);
        e.handle(press("space", 0));  // toggle sym on (swallowed)
        e.handle(release("space", 10));
        assert_eq!(e.handle(press("j", 20)), &[press("1", 20)]);
        e.handle(release("j", 30));
        e.handle(press("space", 40)); // toggle off
        e.handle(release("space", 50));
        assert_eq!(e.handle(press("j", 60)), &[press("j", 60)]);
    }

    #[test]
    fn layer_miss_falls_through_to_base() {
        let mut e = engine(LAYERS);
        e.handle(press("space", 0)); e.handle(release("space", 10)); // sym on
        // 'a' not in sym layer → falls through to base → passthrough
        assert_eq!(e.handle(press("a", 20)), &[press("a", 20)]);
        // but base 'tab = disabled' still applies through the layer
        assert!(e.handle(press("tab", 30)).is_empty());
    }

    #[test]
    fn layer_toggle_cannot_pop_base_layer() {
        // "layer:base" compiles to LayerToggle(0); pressing it must NOT remove layer 0
        let toml = "[profile.default.keys]\na = \"b\"\nspace = \"layer:base\"";
        let mut e = engine(toml);
        e.handle(press("space", 0));
        e.handle(release("space", 10));
        // base layer still active: 'a' still remaps to 'b'
        assert_eq!(e.handle(press("a", 20)), &[press("b", 20)]);
    }

    #[test]
    fn panic_chord_suspends_and_resumes() {
        let mut e = engine("[profile.default.keys]\na = \"b\"");
        e.handle(press("leftctrl", 0));
        e.handle(press("leftalt", 10));
        e.handle(press("backspace", 20)); // chord complete → suspend
        assert!(e.is_suspended());
        e.handle(release("leftctrl", 30)); e.handle(release("leftalt", 31)); e.handle(release("backspace", 32));
        assert_eq!(e.handle(press("a", 40)), &[press("a", 40)]); // raw passthrough
        e.handle(release("a", 45));
        e.handle(press("leftctrl", 50)); e.handle(press("leftalt", 51)); e.handle(press("backspace", 52));
        assert!(!e.is_suspended()); // chord toggles back
    }

    #[test]
    fn suspend_releases_held_outputs() {
        let mut e = engine("[profile.default.keys]\na = \"b\"");
        e.handle(press("a", 0)); // b held
        assert!(e.suspend().contains(&release("b", 0)));
        assert!(e.suspend().is_empty()); // idempotent: second call flushes nothing
    }

    // ── Per-device slots ───────────────────────────────────────────────────────

    const DEV_ENGINE: &str = r#"
        [profile.default.keys]
        a = "b"
        mouse4 = "back"
        [profile.default.layers.nav]
        h = "left"
        [profile.default.device."g600".keys]
        a = "c"
        f = { tap = "f", hold = "layer:nav" }
        [profile.default.device."g600".layers.nav]
        h = "home"
    "#;

    #[test]
    fn device_slot_shadows_global() {
        let mut e = engine(DEV_ENGINE);
        // slot 0 = "g600": device table wins
        assert_eq!(e.handle_on(press("a", 0), Some(0)), &[press("c", 0)]);
        e.handle_on(release("a", 1), Some(0));
        // no slot: global table
        assert_eq!(e.handle_on(press("a", 10), None), &[press("b", 10)]);
        e.handle_on(release("a", 11), None);
        // key absent from device table falls through to global
        assert_eq!(e.handle_on(press("mouse4", 20), Some(0)), &[press("back", 20)]);
    }

    #[test]
    fn device_layer_override_shadows_global_layer() {
        let mut e = engine(DEV_ENGINE);
        e.handle_on(press("f", 0), Some(0));
        e.tick(300_000); // hold → nav layer
        // device nav table says home; global nav says left
        assert_eq!(e.handle_on(press("h", 400_000), Some(0)), &[press("home", 400_000)]);
        e.handle_on(release("h", 410_000), Some(0));
        // same layer, event without a slot → global nav mapping
        assert_eq!(e.handle_on(press("h", 420_000), None), &[press("left", 420_000)]);
    }

    #[test]
    fn buffered_events_replay_with_their_slot() {
        // tap-hold pending on the device; a device-mapped key buffered behind it
        // must resolve through the DEVICE table when replayed.
        let mut e = engine(DEV_ENGINE);
        e.handle_on(press("f", 0), Some(0)); // pending tap-hold (device table)
        e.handle_on(press("a", 50_000), Some(0)); // buffered with slot 0
        // release f before timeout → tap; buffered 'a' replays as device-mapped 'c'
        assert_eq!(
            e.handle_on(release("f", 100_000), Some(0)),
            &[press("f", 0), release("f", 100_000), press("c", 50_000)]
        );
    }

    #[test]
    fn out_of_range_slot_is_global() {
        let mut e = engine(DEV_ENGINE);
        assert_eq!(e.handle_on(press("a", 0), Some(99)), &[press("b", 0)]);
    }

    #[test]
    fn release_pairs_across_slot_loss() {
        // Press resolved via device table; release without a slot still pairs
        // via the held map (release never re-consults the tables).
        let mut e = engine(DEV_ENGINE);
        e.handle_on(press("a", 0), Some(0)); // emits c
        assert_eq!(e.handle_on(release("a", 10), None), &[release("c", 10)]);
    }

    // ── Chord action ──────────────────────────────────────────────────────────

    #[test]
    fn chord_press_emits_in_order_release_in_reverse() {
        let mut e = engine("[profile.default.keys]\nmouse4 = \"ctrl+c\"\n");
        assert_eq!(
            e.handle(press("mouse4", 5)),
            &[press("leftctrl", 5), press("c", 5)]
        );
        assert_eq!(
            e.handle(release("mouse4", 9)),
            &[release("c", 9), release("leftctrl", 9)]
        );
    }

    #[test]
    fn chord_repeat_repeats_only_last_key() {
        let mut e = engine("[profile.default.keys]\nmouse4 = \"ctrl+c\"\n");
        e.handle(press("mouse4", 0));
        let rep = Event { key: key("mouse4"), state: KeyState::Repeat, time_us: 3 };
        assert_eq!(
            e.handle(rep),
            &[Event { key: key("c"), state: KeyState::Repeat, time_us: 3 }]
        );
    }

    #[test]
    fn suspend_releases_chord_in_reverse() {
        let mut e = engine("[profile.default.keys]\nmouse4 = \"ctrl+shift+t\"\n");
        e.handle(press("mouse4", 0));
        let out = e.suspend().to_vec();
        let t = out.iter().position(|x| *x == release("t", 0)).unwrap();
        let s = out.iter().position(|x| *x == release("leftshift", 0)).unwrap();
        let c = out.iter().position(|x| *x == release("leftctrl", 0)).unwrap();
        assert!(t < s && s < c, "reverse order expected, got {out:?}");
    }

    #[test]
    fn paused_profile_is_never_auto_selected() {
        let mut e = engine(
            "[profile.default.keys]\na = \"b\"\n\n[profile.game]\nmatch = { class = \"steam_app_123\" }\nauto_switch = false\n[profile.game.keys]\na = \"x\"\n",
        );
        e.set_focus(&focus("steam_app_123"));
        // Focus matches game's rule, but switching is paused: default stays live.
        assert_eq!(e.handle(press("a", 0)), &[press("b", 0)]);
    }

    // ── release_device ────────────────────────────────────────────────────────

    #[test]
    fn release_device_emits_release_and_clears_entry() {
        // Press remapped key on slot 3; release_device(3) emits the release.
        let mut e = engine("[profile.default.keys]\na = \"b\"");
        e.handle_on(press("a", 0), Some(3)); // emits b-press, held on slot 3
        let out = e.release_device(3).to_vec();
        assert_eq!(out, vec![release("b", 0)]);
        // A subsequent physical release of 'a' finds no held entry → passthrough (raw)
        // but the key point is the 'b' entry was cleared (no second b-release):
        let residual = e.handle_on(release("a", 10), Some(3)).to_vec();
        assert!(!residual.iter().any(|ev| ev.key == key("b")),
            "b-release must not appear after release_device cleared it; got {residual:?}");
    }

    #[test]
    fn release_device_chord_emits_in_reverse() {
        // Chord (ctrl+c) held on slot 2; release_device emits in reverse order.
        let mut e = engine("[profile.default.keys]\nmouse4 = \"ctrl+c\"\n");
        e.handle_on(press("mouse4", 0), Some(2));
        let out = e.release_device(2).to_vec();
        // reverse: c first, then ctrl
        assert_eq!(out, vec![release("c", 0), release("leftctrl", 0)]);
        // physical release now finds no chord entry → passes through as raw mouse4 release
        // but must NOT re-emit c or ctrl
        let residual = e.handle_on(release("mouse4", 10), Some(2)).to_vec();
        assert!(!residual.iter().any(|ev| ev.key == key("c") || ev.key == key("leftctrl")),
            "chord keys must not reappear after release_device; got {residual:?}");
    }

    #[test]
    fn release_device_does_not_touch_other_slots() {
        // Press on slot 1 and slot 3; release_device(3) only clears slot 3.
        let mut e = engine("[profile.default.keys]\na = \"b\"\nb = \"c\"");
        e.handle_on(press("a", 0), Some(1)); // held on slot 1
        e.handle_on(press("b", 1), Some(3)); // held on slot 3
        let out = e.release_device(3).to_vec();
        assert_eq!(out, vec![release("c", 0)]); // only slot-3 entry released
        // slot 1 entry still present: physical release of 'a' still pairs as 'b'
        assert_eq!(e.handle_on(release("a", 20), Some(1)), &[release("b", 20)]);
    }

    #[test]
    fn release_device_layer_held_pops_layer() {
        // LayerHeld variant via tap-hold hold=layer: release_device pops the layer.
        let toml = "[profile.default.keys]\nf = { tap = \"f\", hold = \"layer:nav\" }\n[profile.default.layers.nav]\nh = \"left\"";
        let mut e = engine(toml);
        e.handle_on(press("f", 0), Some(5)); // pending tap-hold on slot 5
        e.tick(200_000); // resolve as hold → LayerHeld(nav) on slot 5
        // nav layer active: h → left
        assert_eq!(e.handle_on(press("h", 250_000), Some(5)), &[press("left", 250_000)]);
        e.handle_on(release("h", 260_000), Some(5));
        // release_device(5) should pop the nav layer, emitting no release events
        let out = e.release_device(5).to_vec();
        assert!(out.is_empty(), "LayerHeld emits no release events; got {out:?}");
        // layer gone: h → h (base layer passthrough)
        assert_eq!(e.handle_on(press("h", 300_000), Some(5)), &[press("h", 300_000)]);
    }

    // ── release_device + pending tap-hold ─────────────────────────────────────

    #[test]
    fn release_device_pending_taphold_resolves_as_tap() {
        // tap-hold key pressed on slot 2 (pending opens); device disappears before
        // release or timeout. Must resolve as tap (press+release of tap key) and
        // leave no pending state for subsequent ticks.
        let toml = "[profile.default.keys]\ncapslock = { tap = \"esc\", hold = \"leftctrl\" }";
        let mut e = engine(toml);
        // Press tap-hold key on slot 2 → pending open
        assert!(e.handle_on(press("capslock", 0), Some(2)).is_empty());
        assert!(e.next_deadline_us().is_some(), "pending should be open");

        // Device slot 2 removed → must emit tap press+release
        let out = e.release_device(2).to_vec();
        assert!(
            out.contains(&press("esc", 0)),
            "expected esc-press in release_device output; got {out:?}"
        );
        assert!(
            out.contains(&release("esc", 0)),
            "expected esc-release in release_device output; got {out:?}"
        );

        // No leftctrl must appear
        assert!(
            !out.iter().any(|ev| ev.key == key("leftctrl")),
            "leftctrl must NOT appear; got {out:?}"
        );

        // Pending is gone: a subsequent tick must emit nothing
        let tick_out = e.tick(500_000).to_vec();
        assert!(
            tick_out.is_empty(),
            "tick after release_device must emit nothing (pending cleared); got {tick_out:?}"
        );

        // next_deadline_us must be None
        assert_eq!(e.next_deadline_us(), None, "no deadline should remain after pending cleared");
    }

    #[test]
    fn release_device_drops_same_slot_buffered_replays_other_slot() {
        // tap-hold on slot 2 (pending); two events buffered: one from slot 2 and one
        // from slot 9.  release_device(2) must:
        //   - resolve pending as tap
        //   - drop the slot-2 buffered event
        //   - replay the slot-9 buffered event through normal processing
        let toml = "[profile.default.keys]\ncapslock = { tap = \"esc\", hold = \"leftctrl\" }\na = \"b\"";
        let mut e = engine(toml);
        // Open pending on slot 2
        assert!(e.handle_on(press("capslock", 0), Some(2)).is_empty());
        // Buffer an event from the SAME slot (slot 2) — must be dropped
        let _ = e.handle_on(press("q", 10_000), Some(2));
        // Buffer an event from a DIFFERENT slot (slot 9) — must replay
        let _ = e.handle_on(press("a", 20_000), Some(9));

        let out = e.release_device(2).to_vec();

        // Tap resolved: esc press+release present
        assert!(out.contains(&press("esc", 0)), "esc-press missing; got {out:?}");
        assert!(out.contains(&release("esc", 0)), "esc-release missing; got {out:?}");

        // 'q' from slot 2 must NOT appear
        assert!(
            !out.iter().any(|ev| ev.key == key("q")),
            "'q' from same slot must be dropped; got {out:?}"
        );

        // 'a' from slot 9 replays and remaps to 'b'
        assert!(
            out.contains(&press("b", 20_000)),
            "slot-9 'a' should replay as 'b'; got {out:?}"
        );
    }
}
