use std::collections::HashMap;
use crate::config::{Action, CompiledConfig, HoldAction};
use crate::event::{Event, Key, KeyState};

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
enum HeldEntry { OutKey(Key), LayerHeld(u8), Swallowed }

struct Pending {
    phys: Key,
    tap: Key,
    hold: HoldAction,
    press_time_us: u64,
    deadline_us: u64,
}

enum Resolution {
    Tap { release_time_us: u64 },
    Hold,
}

pub struct Engine {
    cfg: CompiledConfig,
    profile_idx: usize,
    active_layers: Vec<u8>,     // stack; index 0 is always base layer 0 (Task 5)
    held: HashMap<Key, HeldEntry>,
    out: Vec<Event>,            // reused output buffer
    pending: Option<Pending>,
    buffer: Vec<Event>,
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
        }
    }

    pub fn handle(&mut self, ev: Event) -> &[Event] {
        self.out.clear();
        self.process(ev);
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

    fn lookup(&self, key: Key) -> Action {
        let profile = &self.cfg.profiles[self.profile_idx];
        for &layer in self.active_layers.iter().rev() {
            if let Some(a) = profile.layers[layer as usize][key.0 as usize] { return a; }
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
                    self.held.insert(p.phys, HeldEntry::OutKey(k));
                    self.out.push(Event { key: k, state: KeyState::Press, time_us: p.press_time_us });
                }
                HoldAction::Layer(l) => {
                    self.active_layers.push(l);
                    self.held.insert(p.phys, HeldEntry::LayerHeld(l));
                }
            },
        }
        // Drain buffered events through normal processing.
        // A buffered TapHold press will re-establish pending; subsequent events
        // re-buffer behind it via the pending check at the top of process().
        for ev in std::mem::take(&mut self.buffer) {
            self.process(ev);
        }
    }

    fn process(&mut self, ev: Event) {
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
            self.buffer.push(ev);
            // permissive hold: same key pressed AND released inside the buffer?
            let hold_now = self.buffer.iter().any(|b| {
                b.state == KeyState::Release
                    && self.buffer.iter().any(|b2| b2.key == b.key && b2.state == KeyState::Press)
            });
            if hold_now {
                self.resolve(Resolution::Hold);
            }
            return;
        }

        match ev.state {
            KeyState::Press => match self.lookup(ev.key) {
                Action::Key(out) => {
                    self.held.insert(ev.key, HeldEntry::OutKey(out));
                    self.out.push(Event { key: out, ..ev });
                }
                Action::Passthrough => {
                    self.held.insert(ev.key, HeldEntry::OutKey(ev.key));
                    self.out.push(ev);
                }
                Action::Disabled => { self.held.insert(ev.key, HeldEntry::Swallowed); }
                Action::TapHold { tap, hold, timeout_us } => {
                    self.pending = Some(Pending {
                        phys: ev.key,
                        tap,
                        hold,
                        press_time_us: ev.time_us,
                        deadline_us: ev.time_us + timeout_us,
                    });
                }
                Action::LayerWhileHeld(n) => {
                    self.active_layers.push(n);
                    self.held.insert(ev.key, HeldEntry::LayerHeld(n));
                }
                Action::LayerToggle(n) => {
                    if let Some(pos) = self.active_layers.iter().rposition(|&l| l == n) {
                        // layer 0 (base) can never be popped
                        if pos != 0 { self.active_layers.remove(pos); }
                    } else {
                        self.active_layers.push(n);
                    }
                    self.held.insert(ev.key, HeldEntry::Swallowed);
                }
            },
            KeyState::Release => match self.held.remove(&ev.key) {
                Some(HeldEntry::OutKey(out)) => self.out.push(Event { key: out, ..ev }),
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
            KeyState::Repeat => match self.held.get(&ev.key) {
                Some(HeldEntry::OutKey(out)) => { let out = *out; self.out.push(Event { key: out, ..ev }); }
                Some(_) => {}
                None => self.out.push(ev),
            },
        }
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

}
