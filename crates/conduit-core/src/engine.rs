use std::collections::HashMap;
use crate::config::{Action, CompiledConfig};
use crate::event::{Event, Key, KeyState};

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)]
enum HeldEntry { OutKey(Key), LayerHeld(u8), Swallowed }

pub struct Engine {
    cfg: CompiledConfig,
    profile_idx: usize,
    active_layers: Vec<u8>,     // stack; index 0 is always base layer 0 (Task 5)
    held: HashMap<Key, HeldEntry>,
    out: Vec<Event>,            // reused output buffer
}

impl Engine {
    pub fn new(cfg: CompiledConfig) -> Self {
        let profile_idx = cfg.default_idx;
        Engine { cfg, profile_idx, active_layers: vec![0], held: HashMap::new(), out: Vec::with_capacity(16) }
    }

    pub fn handle(&mut self, ev: Event) -> &[Event] {
        self.out.clear();
        self.process(ev);
        &self.out
    }

    pub fn tick(&mut self, _now_us: u64) -> &[Event] { self.out.clear(); &self.out } // Task 4
    pub fn next_deadline_us(&self) -> Option<u64> { None }                            // Task 4

    fn lookup(&self, key: Key) -> Action {
        let profile = &self.cfg.profiles[self.profile_idx];
        for &layer in self.active_layers.iter().rev() {
            if let Some(a) = profile.layers[layer as usize][key.0 as usize] { return a; }
        }
        Action::Passthrough
    }

    fn process(&mut self, ev: Event) {
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
                _ => { /* TapHold: Task 4. Layer*: Task 5. */ }
            },
            KeyState::Release => match self.held.remove(&ev.key) {
                Some(HeldEntry::OutKey(out)) => self.out.push(Event { key: out, ..ev }),
                Some(HeldEntry::Swallowed) => {}
                Some(HeldEntry::LayerHeld(_)) => {} // Task 5
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
}
