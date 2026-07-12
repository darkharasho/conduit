# KDE Wayland Focus + Mouse + Hardware Detection + App Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-app profiles on KDE Plasma Wayland, remappable scroll wheels + `grab_all_mice`, capability-based device classification with vid:pid selectors, and a UI match editor linking profiles to applications.

**Architecture:** A new `focus/kde.rs` backend injects a KWin script over D-Bus (zbus) that calls back into a daemon-hosted D-Bus service on window activation. Wheel ticks become pseudo-key codes (0x2F8–0x2FB) that flow through the existing engine and are re-materialized as REL events by `VirtualOutput`. `devices::probe` gains a pure `classify()` over capability sets and a `DeviceSelector` grammar (`name` | `vid:pid` | `vid:pid/name`).

**Tech Stack:** Rust (evdev 0.12, zbus 5, crossbeam-channel), KWin JavaScript scripting API, React + TypeScript + vitest (smol-toml).

**Spec:** `docs/superpowers/specs/2026-07-12-kde-wayland-mouse-hw-design.md`

## Global Constraints

- vitest MUST run with `--maxWorkers=2` or lower (global CLAUDE.md, 32 GB shared machine).
- Wheel pseudo-key codes: `wheelup`=0x2F8 (760), `wheeldown`=0x2F9 (761), `wheelleft`=0x2FA (762), `wheelright`=0x2FB (763). All < KEY_TABLE_SIZE (768).
- D-Bus names: daemon service `org.conduit.Conduit`, winlist helper `org.conduit.WinList`, object path `/org/conduit/Focus`, interface `org.conduit.Focus`. KWin plugin names: `conduit-focus`, `conduit-winlist`.
- Existing plain-name entries in `grab_keyboards`/`grab_mice` must keep working unchanged.
- Touchpads are NEVER grabbed by `grab_all_mice`; explicit `grab_mice` selector required.
- Commit after each task; run `cargo test --workspace` (Rust) before each commit.

---

### Task 1: conduit-core — wheel pseudo-keys and mouse button names

**Files:**
- Modify: `crates/conduit-core/src/keys.rs`

**Interfaces:**
- Produces: `keys::WHEEL_UP/WHEEL_DOWN/WHEEL_LEFT/WHEEL_RIGHT: Key` consts, `keys::is_wheel(Key) -> bool`, names `btn_forward`/`btn_back`/`btn_task`/`wheelup`/`wheeldown`/`wheelleft`/`wheelright` resolvable via `from_name`.

- [ ] **Step 1: Write failing tests** — append to `keys.rs` tests:

```rust
#[test]
fn wheel_and_button_names_round_trip() {
    for name in ["btn_forward", "btn_back", "btn_task", "wheelup", "wheeldown", "wheelleft", "wheelright"] {
        let k = from_name(name).expect(name);
        assert_eq!(super::name(k), name);
    }
}

#[test]
fn wheel_consts_and_predicate() {
    assert_eq!(from_name("wheelup"), Some(WHEEL_UP));
    assert_eq!(from_name("wheeldown"), Some(WHEEL_DOWN));
    assert_eq!(from_name("wheelleft"), Some(WHEEL_LEFT));
    assert_eq!(from_name("wheelright"), Some(WHEEL_RIGHT));
    for k in [WHEEL_UP, WHEEL_DOWN, WHEEL_LEFT, WHEEL_RIGHT] {
        assert!(is_wheel(k));
        assert!((k.0 as usize) < crate::config::KEY_TABLE_SIZE);
    }
    assert!(!is_wheel(Key(30)));
    assert!(!is_wheel(Key(272)));
}
```

- [ ] **Step 2: Run** `cargo test -p conduit-core keys` — expect FAIL (unresolved names).
- [ ] **Step 3: Implement** — extend `KEYS` table:

```rust
    ("btn_left", 272), ("btn_right", 273), ("btn_middle", 274),
    ("mouse4", 275), ("mouse5", 276), // BTN_SIDE / BTN_EXTRA — canonical UI names
    ("btn_forward", 277), ("btn_back", 278), ("btn_task", 279),
    // Wheel pseudo-keys: unassigned evdev codes used internally so scroll
    // ticks can flow through the engine as ordinary key events.
    ("wheelup", 760), ("wheeldown", 761), ("wheelleft", 762), ("wheelright", 763),
```

and add below `is_mouse_button`:

```rust
pub const WHEEL_UP: Key = Key(760);
pub const WHEEL_DOWN: Key = Key(761);
pub const WHEEL_LEFT: Key = Key(762);
pub const WHEEL_RIGHT: Key = Key(763);

pub fn is_wheel(key: Key) -> bool {
    (760..=763).contains(&key.0)
}
```

- [ ] **Step 4: Run** `cargo test -p conduit-core` — expect PASS.
- [ ] **Step 5: Commit** `feat(core): wheel pseudo-keys and full mouse button names`

---

### Task 2: conduit-core — `grab_all_mice` setting

**Files:**
- Modify: `crates/conduit-core/src/config.rs`

**Interfaces:**
- Produces: `Settings.grab_all_mice: bool` (default false).

- [ ] **Step 1: Failing test** in `config.rs` tests:

```rust
#[test]
fn grab_all_mice_parses_and_defaults_false() {
    let s = compile("[devices]\ngrab_all_mice = true").unwrap().settings;
    assert!(s.grab_all_mice);
    let s = compile("[profile.default.keys]\na = \"b\"").unwrap().settings;
    assert!(!s.grab_all_mice);
}
```

- [ ] **Step 2: Run** `cargo test -p conduit-core grab_all_mice` — FAIL (no field).
- [ ] **Step 3: Implement** — `Settings` gains `pub grab_all_mice: bool,`; `RawDevices` gains `#[serde(default)] grab_all_mice: bool,`; the `Settings { ... }` construction in `compile` gains `grab_all_mice: raw.devices.grab_all_mice,`. Fix the two daemon test fixtures that construct `Settings` via `compile` (none construct it literally — verify with `cargo test --workspace`).
- [ ] **Step 4: Run** `cargo test --workspace` — PASS.
- [ ] **Step 5: Commit** `feat(core): grab_all_mice device setting`

---

### Task 3: daemon — pure device classification + selector grammar

**Files:**
- Create: `crates/conduit-daemon/src/classify.rs`
- Modify: `crates/conduit-daemon/src/lib.rs` (add `pub mod classify;`)

**Interfaces:**
- Produces:
  - `enum DeviceClass { Keyboard, Mouse, Touchpad, Gamepad, MediaKeys, Other }` with `pub fn as_str(&self) -> &'static str` (lowercase: `"keyboard"`, `"mouse"`, `"touchpad"`, `"gamepad"`, `"media"`, `"other"`).
  - `struct Caps { pub keys: Vec<u16>, pub rel_x_y: bool, pub abs_x_y: bool, pub prop_pointer: bool }`
  - `pub fn classify(c: &Caps) -> DeviceClass`
  - `enum DeviceSelector { Name(String), VidPid(u16,u16), VidPidName(u16,u16,String) }` with `parse(&str) -> DeviceSelector` (infallible) and `matches(&self, name: &str, vendor: u16, product: u16) -> bool`.

- [ ] **Step 1: Write module with failing tests.** Full content of `classify.rs`:

```rust
//! Pure device classification and grab-list selector matching.
//!
//! `classify` looks only at capability sets (no device I/O) so it is fully
//! unit-testable; `devices::probe` builds a `Caps` from a live evdev device.

const BTN_LEFT: u16 = 0x110;
const BTN_JOYSTICK_FIRST: u16 = 0x120; // BTN_TRIGGER
const BTN_JOYSTICK_LAST: u16 = 0x12f;
const BTN_GAMEPAD_FIRST: u16 = 0x130; // BTN_SOUTH
const BTN_GAMEPAD_LAST: u16 = 0x13e;
const BTN_TOUCH: u16 = 0x14a;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceClass { Keyboard, Mouse, Touchpad, Gamepad, MediaKeys, Other }

impl DeviceClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            DeviceClass::Keyboard => "keyboard",
            DeviceClass::Mouse => "mouse",
            DeviceClass::Touchpad => "touchpad",
            DeviceClass::Gamepad => "gamepad",
            DeviceClass::MediaKeys => "media",
            DeviceClass::Other => "other",
        }
    }
}

/// Capability summary of an input device node.
#[derive(Debug, Default, Clone)]
pub struct Caps {
    /// Supported EV_KEY codes.
    pub keys: Vec<u16>,
    /// Has both REL_X and REL_Y.
    pub rel_x_y: bool,
    /// Has both ABS_X and ABS_Y.
    pub abs_x_y: bool,
    /// INPUT_PROP_POINTER set.
    pub prop_pointer: bool,
}

/// Classify a device node from its capabilities. First match wins:
/// Touchpad → Gamepad → Mouse → Keyboard (≥20 typing keys) → MediaKeys → Other.
pub fn classify(c: &Caps) -> DeviceClass {
    let has = |code: u16| c.keys.contains(&code);
    if c.abs_x_y && (has(BTN_TOUCH) || c.prop_pointer) {
        return DeviceClass::Touchpad;
    }
    if c.keys.iter().any(|k| (BTN_GAMEPAD_FIRST..=BTN_GAMEPAD_LAST).contains(k))
        || c.keys.iter().any(|k| (BTN_JOYSTICK_FIRST..=BTN_JOYSTICK_LAST).contains(k))
    {
        return DeviceClass::Gamepad;
    }
    if c.rel_x_y && has(BTN_LEFT) {
        return DeviceClass::Mouse;
    }
    // Typing keys: ESC(1)..CAPSLOCK(58) block — letters, digits, punctuation,
    // enter, space. Consumer/System Control nodes declare media keys outside
    // this block and stay below the threshold.
    let typing = c.keys.iter().filter(|k| (1..=58).contains(*k)).count();
    if typing >= 20 {
        return DeviceClass::Keyboard;
    }
    if !c.keys.is_empty() {
        return DeviceClass::MediaKeys;
    }
    DeviceClass::Other
}

/// One entry in `grab_keyboards` / `grab_mice`.
///
/// Grammar (back-compat: anything unparseable is a plain name):
/// - `"AT Translated Set 2 keyboard"` — exact name
/// - `"046d:c24a"` — vendor:product hex
/// - `"046d:c24a/Logitech Gaming Mouse G600 Keyboard"` — vendor:product/name
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeviceSelector {
    Name(String),
    VidPid(u16, u16),
    VidPidName(u16, u16, String),
}

fn parse_vid_pid(s: &str) -> Option<(u16, u16)> {
    let (v, p) = s.split_once(':')?;
    if v.len() != 4 || p.len() != 4 {
        return None;
    }
    Some((u16::from_str_radix(v, 16).ok()?, u16::from_str_radix(p, 16).ok()?))
}

impl DeviceSelector {
    pub fn parse(s: &str) -> DeviceSelector {
        if let Some((vp, name)) = s.split_once('/') {
            if let Some((v, p)) = parse_vid_pid(vp) {
                return DeviceSelector::VidPidName(v, p, name.to_string());
            }
        }
        if let Some((v, p)) = parse_vid_pid(s) {
            return DeviceSelector::VidPid(v, p);
        }
        DeviceSelector::Name(s.to_string())
    }

    pub fn matches(&self, name: &str, vendor: u16, product: u16) -> bool {
        match self {
            DeviceSelector::Name(n) => n == name,
            DeviceSelector::VidPid(v, p) => *v == vendor && *p == product,
            DeviceSelector::VidPidName(v, p, n) => *v == vendor && *p == product && n == name,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(keys: Vec<u16>, rel_x_y: bool, abs_x_y: bool, prop_pointer: bool) -> Caps {
        Caps { keys, rel_x_y, abs_x_y, prop_pointer }
    }
    fn typing_keys() -> Vec<u16> { (1..=58).collect() }

    // Modeled on the real machine inventory (see spec).
    #[test]
    fn wooting_main_node_is_keyboard() {
        assert_eq!(classify(&caps(typing_keys(), false, false, false)), DeviceClass::Keyboard);
    }
    #[test]
    fn wooting_mouse_node_is_mouse() {
        assert_eq!(classify(&caps(vec![0x110, 0x111, 0x112], true, false, false)), DeviceClass::Mouse);
    }
    #[test]
    fn g600_keyboard_node_is_keyboard() {
        // Full HID keyboard caps but no REL axes.
        assert_eq!(classify(&caps(typing_keys(), false, false, false)), DeviceClass::Keyboard);
    }
    #[test]
    fn consumer_control_node_is_media_not_keyboard() {
        // Volume/media keys only (KEY_MUTE=113, VOLUP=115, PLAYPAUSE=164...).
        assert_eq!(classify(&caps(vec![113, 114, 115, 163, 164, 165], false, false, false)), DeviceClass::MediaKeys);
    }
    #[test]
    fn power_button_is_media() {
        assert_eq!(classify(&caps(vec![116], false, false, false)), DeviceClass::MediaKeys);
    }
    #[test]
    fn touchpad_is_touchpad_not_mouse() {
        assert_eq!(classify(&caps(vec![0x110, 0x14a], true, true, true)), DeviceClass::Touchpad);
    }
    #[test]
    fn gamepad_detected_before_mouse() {
        assert_eq!(classify(&caps(vec![0x110, 0x130, 0x131], true, false, false)), DeviceClass::Gamepad);
    }
    #[test]
    fn no_keys_no_axes_is_other() {
        assert_eq!(classify(&caps(vec![], false, false, false)), DeviceClass::Other);
    }

    #[test]
    fn selector_parse_forms() {
        assert_eq!(DeviceSelector::parse("My Kbd"), DeviceSelector::Name("My Kbd".into()));
        assert_eq!(DeviceSelector::parse("046d:c24a"), DeviceSelector::VidPid(0x046d, 0xc24a));
        assert_eq!(
            DeviceSelector::parse("046d:c24a/G600 Keyboard"),
            DeviceSelector::VidPidName(0x046d, 0xc24a, "G600 Keyboard".into())
        );
        // Not hex / wrong width → plain name (back-compat).
        assert_eq!(DeviceSelector::parse("46d:c24a"), DeviceSelector::Name("46d:c24a".into()));
        assert_eq!(DeviceSelector::parse("zzzz:c24a"), DeviceSelector::Name("zzzz:c24a".into()));
        // Name containing '/' without a vid:pid prefix stays a name.
        assert_eq!(DeviceSelector::parse("Foo/Bar"), DeviceSelector::Name("Foo/Bar".into()));
    }
    #[test]
    fn selector_matching() {
        assert!(DeviceSelector::parse("046d:c24a").matches("anything", 0x046d, 0xc24a));
        assert!(!DeviceSelector::parse("046d:c24a").matches("anything", 0x046d, 0xc24b));
        assert!(DeviceSelector::parse("046d:c24a/G600").matches("G600", 0x046d, 0xc24a));
        assert!(!DeviceSelector::parse("046d:c24a/G600").matches("Other", 0x046d, 0xc24a));
        assert!(DeviceSelector::parse("G600").matches("G600", 0, 0));
    }
}
```

- [ ] **Step 2: Run** `cargo test -p conduit-daemon classify` — FAIL (module missing) → add `pub mod classify;` to `lib.rs`, re-run — PASS.
- [ ] **Step 3: Commit** `feat(daemon): capability-based device classification and grab selectors`

---

### Task 4: daemon — integrate classification into probe/should_grab

**Files:**
- Modify: `crates/conduit-daemon/src/devices.rs`
- Modify: `crates/conduit-daemon/src/runloop.rs:244-253` (DeviceInfo build), `crates/conduit-daemon/src/ipc.rs:315-342` (list_devices build), `crates/conduit-daemon/src/lib.rs:151-163` (start-up grab loop)

**Interfaces:**
- Consumes: `classify::{classify, Caps, DeviceClass, DeviceSelector}` (Task 3).
- Produces: `Discovered { path, name, vendor, product, phys: String, class: DeviceClass }` with methods `id() -> String` (`{vendor:04x}:{product:04x}/{name}`), `is_keyboard() -> bool`, `is_mouse() -> bool` (class equality); `should_grab(&Discovered, &Settings) -> bool` with new rules; `spawn_reader(path, is_pointer: bool, do_grab, tx, out)` (`is_pointer` replaces `is_mouse`, true for Mouse|Touchpad).

- [ ] **Step 1: Rewrite the `should_grab` tests** (replace existing test helpers) to cover the new rules:

```rust
fn dev(name: &str, class: DeviceClass) -> Discovered {
    Discovered {
        path: "/dev/input/event0".into(),
        name: name.into(),
        vendor: 0x046d,
        product: 0xc24a,
        phys: String::new(),
        class,
    }
}

#[test]
fn grab_rules_by_class_and_selector() {
    let s = conduit_core::config::compile(
        "[devices]\ngrab_all_keyboards = true\ngrab_mice = [\"046d:c24a\"]",
    ).unwrap().settings;
    assert!(should_grab(&dev("Any Kbd", DeviceClass::Keyboard), &s));
    assert!(should_grab(&dev("G600", DeviceClass::Mouse), &s));           // vid:pid selector
    assert!(!should_grab(&dev("Consumer Ctl", DeviceClass::MediaKeys), &s)); // media never grabbed by grab_all_keyboards
    assert!(!should_grab(&dev("Pad", DeviceClass::Other), &s));
}

#[test]
fn grab_all_mice_excludes_touchpads() {
    let s = conduit_core::config::compile("[devices]\ngrab_all_mice = true").unwrap().settings;
    assert!(should_grab(&dev("G600", DeviceClass::Mouse), &s));
    assert!(!should_grab(&dev("Synaptics", DeviceClass::Touchpad), &s));
}

#[test]
fn touchpad_grabbed_only_by_explicit_selector() {
    let s = conduit_core::config::compile(
        "[devices]\ngrab_all_mice = true\ngrab_mice = [\"Synaptics\"]",
    ).unwrap().settings;
    assert!(should_grab(&dev("Synaptics", DeviceClass::Touchpad), &s));
}

#[test]
fn conduit_virtual_never_grabbed() {
    let s = conduit_core::config::compile("[devices]\ngrab_all_keyboards = true\ngrab_all_mice = true").unwrap().settings;
    assert!(!should_grab(&dev("Conduit Virtual Keyboard", DeviceClass::Keyboard), &s));
    assert!(!should_grab(&dev("Conduit Virtual Mouse", DeviceClass::Mouse), &s));
}

#[test]
fn discovered_id_format() {
    assert_eq!(dev("G600", DeviceClass::Mouse).id(), "046d:c24a/G600");
}
```

- [ ] **Step 2: Run** `cargo test -p conduit-daemon devices` — FAIL (struct shape).
- [ ] **Step 3: Implement.**

`Discovered` + helpers:

```rust
use crate::classify::{classify, Caps, DeviceClass, DeviceSelector};

#[derive(Debug, Clone)]
pub struct Discovered {
    pub path: PathBuf,
    pub name: String,
    pub vendor: u16,
    pub product: u16,
    pub phys: String,
    pub class: DeviceClass,
}

impl Discovered {
    /// Canonical selector: `vid:pid/name`.
    pub fn id(&self) -> String {
        format!("{:04x}:{:04x}/{}", self.vendor, self.product, self.name)
    }
    pub fn is_keyboard(&self) -> bool { self.class == DeviceClass::Keyboard }
    pub fn is_mouse(&self) -> bool { self.class == DeviceClass::Mouse }
    /// Pointer-ish devices get their EV_REL/EV_MSC events forwarded raw.
    pub fn is_pointer(&self) -> bool {
        matches!(self.class, DeviceClass::Mouse | DeviceClass::Touchpad)
    }
}
```

`probe` builds `Caps` from evdev:

```rust
pub fn probe(path: PathBuf) -> Option<Discovered> {
    let dev = evdev::Device::open(&path).ok()?;
    let name = dev.name().unwrap_or("").to_owned();
    if name.starts_with("Conduit Virtual") {
        return None;
    }
    let id = dev.input_id();
    let keys: Vec<u16> = dev
        .supported_keys()
        .map(|set| set.iter().map(|k| k.code()).collect())
        .unwrap_or_default();
    let rel = dev.supported_relative_axes();
    let rel_x_y = rel.as_ref().map_or(false, |r| {
        r.contains(evdev::RelativeAxisType::REL_X) && r.contains(evdev::RelativeAxisType::REL_Y)
    });
    let abs = dev.supported_absolute_axes();
    let abs_x_y = abs.as_ref().map_or(false, |a| {
        a.contains(evdev::AbsoluteAxisType::ABS_X) && a.contains(evdev::AbsoluteAxisType::ABS_Y)
    });
    let prop_pointer = dev.properties().contains(evdev::PropType::POINTER);
    let caps = Caps { keys, rel_x_y, abs_x_y, prop_pointer };
    Some(Discovered {
        path,
        name,
        vendor: id.vendor(),
        product: id.product(),
        phys: dev.physical_path().unwrap_or("").to_owned(),
        class: classify(&caps),
    })
}
```

`should_grab`:

```rust
pub fn should_grab(d: &Discovered, s: &Settings) -> bool {
    if d.name.starts_with("Conduit Virtual") {
        return false;
    }
    let matched = |list: &[String]| {
        list.iter().any(|e| DeviceSelector::parse(e).matches(&d.name, d.vendor, d.product))
    };
    match d.class {
        DeviceClass::Keyboard => s.grab_all_keyboards || matched(&s.grab_keyboards),
        DeviceClass::Mouse => s.grab_all_mice || matched(&s.grab_mice),
        // Grabbing a touchpad kills compositor gestures — explicit opt-in only.
        DeviceClass::Touchpad => matched(&s.grab_mice),
        _ => false,
    }
}
```

`spawn_reader`: rename param `is_mouse` → `is_pointer` (behavior unchanged this task). Ripple call sites: `lib.rs` start loop uses `d.is_pointer()`; `runloop.rs try_grab_device` uses `discovered.is_pointer()`; `runloop.rs` Query(Devices) and `ipc.rs` list_devices use `d.is_keyboard()` / `d.is_mouse()` method calls instead of fields (DeviceInfo proto unchanged until Task 6).

- [ ] **Step 4: Run** `cargo test --workspace` — PASS (fix any missed call sites).
- [ ] **Step 5: Commit** `feat(daemon): classify devices by capabilities; selector-based grab lists`

---

### Task 5: daemon — wheel remapping (reader translation + output materialization)

**Files:**
- Modify: `crates/conduit-daemon/src/devices.rs` (reader loop + new pure fn)
- Modify: `crates/conduit-daemon/src/output.rs`

**Interfaces:**
- Consumes: `keys::{WHEEL_UP, WHEEL_DOWN, WHEEL_LEFT, WHEEL_RIGHT, is_wheel}` (Task 1).
- Produces: `devices::wheel_events(rel_code: u16, value: i32, now: u64) -> Vec<Event>`; `output::wheel_rel(Key) -> Option<(u16 /*REL code*/, i32 /*delta*/)>`.

- [ ] **Step 1: Failing tests.**

In `devices.rs`:

```rust
use conduit_core::keys as ckeys;

#[test]
fn wheel_events_translate_ticks() {
    // REL_WHEEL +1 → wheelup press+release
    let evs = wheel_events(REL_WHEEL, 1, 42);
    assert_eq!(evs.len(), 2);
    assert_eq!(evs[0], Event { key: ckeys::WHEEL_UP, state: KeyState::Press, time_us: 42 });
    assert_eq!(evs[1], Event { key: ckeys::WHEEL_UP, state: KeyState::Release, time_us: 42 });
    // value -3 → three wheeldown pairs
    let evs = wheel_events(REL_WHEEL, -3, 0);
    assert_eq!(evs.len(), 6);
    assert!(evs.iter().all(|e| e.key == ckeys::WHEEL_DOWN));
    // HWHEEL: positive = right, negative = left
    assert_eq!(wheel_events(REL_HWHEEL, 1, 0)[0].key, ckeys::WHEEL_RIGHT);
    assert_eq!(wheel_events(REL_HWHEEL, -1, 0)[0].key, ckeys::WHEEL_LEFT);
    // zero and unknown codes → nothing
    assert!(wheel_events(REL_WHEEL, 0, 0).is_empty());
    assert!(wheel_events(0x00, 5, 0).is_empty()); // REL_X
}
```

In `output.rs`:

```rust
#[test]
fn wheel_rel_maps_pseudo_keys_to_rel_events() {
    use conduit_core::keys;
    assert_eq!(wheel_rel(keys::WHEEL_UP), Some((0x08, 1)));
    assert_eq!(wheel_rel(keys::WHEEL_DOWN), Some((0x08, -1)));
    assert_eq!(wheel_rel(keys::WHEEL_LEFT), Some((0x06, -1)));
    assert_eq!(wheel_rel(keys::WHEEL_RIGHT), Some((0x06, 1)));
    assert_eq!(wheel_rel(Key(30)), None);
}
```

- [ ] **Step 2: Run** `cargo test -p conduit-daemon wheel` — FAIL.
- [ ] **Step 3: Implement.**

`devices.rs` — constants + pure fn:

```rust
pub const REL_HWHEEL: u16 = 0x06;
pub const REL_WHEEL: u16 = 0x08;
pub const REL_WHEEL_HI_RES: u16 = 0x0b;
pub const REL_HWHEEL_HI_RES: u16 = 0x0c;

/// Translate a wheel REL event into engine key events: one Press+Release pair
/// of the matching pseudo-key per tick.
pub fn wheel_events(rel_code: u16, value: i32, now: u64) -> Vec<Event> {
    use conduit_core::keys as k;
    let key = match (rel_code, value > 0) {
        (REL_WHEEL, true) => k::WHEEL_UP,
        (REL_WHEEL, false) => k::WHEEL_DOWN,
        (REL_HWHEEL, true) => k::WHEEL_RIGHT,
        (REL_HWHEEL, false) => k::WHEEL_LEFT,
        _ => return Vec::new(),
    };
    if value == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(value.unsigned_abs() as usize * 2);
    for _ in 0..value.unsigned_abs() {
        out.push(Event { key, state: KeyState::Press, time_us: now });
        out.push(Event { key, state: KeyState::Release, time_us: now });
    }
    out
}
```

Reader loop: replace the `else if is_mouse && (RELATIVE || MISC)` branch (using the `is_pointer` param name from Task 4):

```rust
} else if is_pointer && ev_type == evdev::EventType::RELATIVE {
    match raw.code() {
        REL_WHEEL | REL_HWHEEL => {
            // Wheel goes through the engine so it can be remapped.
            for ev in wheel_events(raw.code(), raw.value(), now_us()) {
                if tx.send(Msg::Input(ev)).is_err() {
                    return;
                }
            }
        }
        // Hi-res wheel would double-scroll alongside the synthesized
        // low-res ticks; libinput re-derives hi-res downstream.
        REL_WHEEL_HI_RES | REL_HWHEEL_HI_RES => {}
        _ => {
            // Motion stays on the direct path — no channel hop.
            if let Ok(mut o) = out.lock() {
                let _ = o.emit_raw_mouse(&raw);
            }
        }
    }
} else if is_pointer && ev_type == evdev::EventType::MISC {
    if let Ok(mut o) = out.lock() {
        let _ = o.emit_raw_mouse(&raw);
    }
}
```

`output.rs`:

```rust
/// Map a wheel pseudo-key back to its (REL code, delta). `None` for real keys.
pub fn wheel_rel(key: conduit_core::event::Key) -> Option<(u16, i32)> {
    use conduit_core::keys as k;
    match key {
        k::WHEEL_UP => Some((0x08, 1)),
        k::WHEEL_DOWN => Some((0x08, -1)),
        k::WHEEL_LEFT => Some((0x06, -1)),
        k::WHEEL_RIGHT => Some((0x06, 1)),
        _ => None,
    }
}
```

In `VirtualOutput::emit`, before the existing routing:

```rust
// Wheel pseudo-keys re-materialize as REL events on the virtual mouse.
// Press carries the tick; Release is swallowed.
if let Some((code, delta)) = wheel_rel(ev.key) {
    if ev.state == KeyState::Press {
        let raw = InputEvent::new(EventType::RELATIVE, code, delta);
        self.mouse.emit(&[raw]).context("emitting wheel event")?;
    }
    return Ok(());
}
```

In `build_keyboard`, also skip pseudo codes:

```rust
if (0x100..=0x15f).contains(&code) || (760..=763).contains(&code) {
    continue;
}
```

- [ ] **Step 4: Run** `cargo test --workspace` — PASS.
- [ ] **Step 5: Commit** `feat(daemon): scroll wheel remapping via pseudo-keys`

---

### Task 6: proto + IPC — extended DeviceInfo

**Files:**
- Modify: `crates/conduit-proto/src/lib.rs`
- Modify: `crates/conduit-daemon/src/ipc.rs:315-342`, `crates/conduit-daemon/src/runloop.rs:237-256`
- Modify: `ui/src/lib/client.ts` (DeviceInfo type only)

**Interfaces:**
- Produces: `DeviceInfo` gains `pub id: String, pub class: String, pub phys: String` (all serialized; `class` is `DeviceClass::as_str()`).

- [ ] **Step 1: Failing test** — extend `wire_shapes_are_stable` in proto:

```rust
let one = Response::Devices {
    devices: vec![DeviceInfo {
        path: "/dev/input/event0".into(),
        name: "G600".into(),
        vendor: 0x046d,
        product: 0xc24a,
        is_keyboard: false,
        is_mouse: true,
        grabbed: true,
        id: "046d:c24a/G600".into(),
        class: "mouse".into(),
        phys: "usb-0000:00:14.0-1/input0".into(),
    }],
};
let json = serde_json::to_string(&one).unwrap();
assert!(json.contains("\"id\":\"046d:c24a/G600\""));
assert!(json.contains("\"class\":\"mouse\""));
```

- [ ] **Step 2: Run** `cargo test -p conduit-proto` — FAIL (missing fields).
- [ ] **Step 3: Implement** — add the three `String` fields to `DeviceInfo`; update both daemon construction sites to fill them (`id: d.id()`, `class: d.class.as_str().to_string()`, `phys: d.phys.clone()`, and `is_keyboard: d.is_keyboard()`, `is_mouse: d.is_mouse()`); update `ui/src/lib/client.ts` `DeviceInfo` interface with `id: string; class: string; phys: string;`.
- [ ] **Step 4: Run** `cargo test --workspace` and `cd ui && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(proto): device id, class, and phys in DeviceInfo`

---

### Task 7: daemon — KDE Wayland focus backend

**Files:**
- Create: `crates/conduit-daemon/src/focus/kde.rs`
- Modify: `crates/conduit-daemon/src/focus/mod.rs` (detect order, list_windows, shared `read_comm`)
- Modify: `crates/conduit-daemon/src/focus/hyprland.rs` (use shared `read_comm`)
- Modify: `crates/conduit-daemon/Cargo.toml` (`zbus = "5"`)

**Interfaces:**
- Consumes: `FocusBackend` trait, `Msg::Focus`, `next_backoff` (move to `focus/mod.rs` or import from hyprland).
- Produces: `kde::KdeBackend::new() -> Option<KdeBackend>`, `kde::available() -> bool`, `kde::list_windows() -> Vec<FocusInfo>`, `focus::read_comm(pid: u32) -> String` (pub(crate), moved from hyprland.rs).

**KWin script templates** (consts in `kde.rs`; `{{SERVICE}}` replaced at write time):

```rust
const FOCUS_SCRIPT: &str = r#"
// conduit-focus: push active-window changes to the Conduit daemon over D-Bus.
var SERVICE = "{{SERVICE}}";
var current = null;

function notify(w) {
    callDBus(SERVICE, "/org/conduit/Focus", "org.conduit.Focus", "NotifyActiveWindow",
        w ? String(w.caption || "") : "",
        w ? String(w.resourceClass || "") : "",
        w ? (w.pid || 0) : 0);
}

function onCaptionChanged() { notify(current); }

function activated(w) {
    if (current !== null) {
        try { current.captionChanged.disconnect(onCaptionChanged); } catch (e) {}
    }
    current = w;
    if (current !== null) {
        try { current.captionChanged.connect(onCaptionChanged); } catch (e) {}
    }
    notify(w);
}

if (workspace.windowActivated !== undefined) {
    workspace.windowActivated.connect(activated);   // Plasma 6
    activated(workspace.activeWindow);
} else {
    workspace.clientActivated.connect(activated);   // Plasma 5
    activated(workspace.activeClient);
}
"#;

const WINLIST_SCRIPT: &str = r#"
// conduit-winlist: one-shot dump of the window list, then unloaded by the daemon.
var SERVICE = "{{SERVICE}}";
var list = (workspace.windowList !== undefined) ? workspace.windowList() : workspace.clientList();
var out = [];
for (var i = 0; i < list.length; ++i) {
    var w = list[i];
    if (w.normalWindow === false) continue;
    out.push({ title: String(w.caption || ""), class: String(w.resourceClass || ""), pid: w.pid || 0 });
}
callDBus(SERVICE, "/org/conduit/Focus", "org.conduit.Focus", "NotifyWindowList", JSON.stringify(out));
"#;
```

**Module skeleton** (blocking zbus; one thread):

```rust
use std::sync::mpsc;
use crossbeam_channel::Sender;
use conduit_proto::FocusInfo;
use zbus::blocking::{connection, fdo::DBusProxy, Connection, Proxy};

use super::{read_comm, FocusBackend};
use crate::runloop::Msg;

pub const SERVICE: &str = "org.conduit.Conduit";
const WINLIST_SERVICE: &str = "org.conduit.WinList";
const OBJ_PATH: &str = "/org/conduit/Focus";

/// D-Bus interface KWin scripts call back into.
struct FocusIface {
    focus_tx: Option<Sender<Msg>>,               // persistent backend
    winlist_tx: Option<mpsc::Sender<Vec<FocusInfo>>>, // one-shot list_windows
}

#[zbus::interface(name = "org.conduit.Focus")]
impl FocusIface {
    fn notify_active_window(&self, caption: String, resource_class: String, pid: i32) {
        if let Some(tx) = &self.focus_tx {
            let process = if pid > 0 { read_comm(pid as u32) } else { String::new() };
            let _ = tx.send(Msg::Focus(FocusInfo { process, class: resource_class, title: caption }));
        }
    }
    fn notify_window_list(&self, json: String) {
        if let Some(tx) = &self.winlist_tx {
            let _ = tx.send(parse_window_list(&json));
        }
    }
}

/// Parse the JSON array produced by WINLIST_SCRIPT. Malformed input → empty.
pub fn parse_window_list(json: &str) -> Vec<FocusInfo> {
    let Ok(vals) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        return Vec::new();
    };
    vals.iter()
        .map(|v| {
            let pid = v["pid"].as_u64().unwrap_or(0) as u32;
            FocusInfo {
                process: if pid > 0 { read_comm(pid) } else { String::new() },
                class: v["class"].as_str().unwrap_or("").to_string(),
                title: v["title"].as_str().unwrap_or("").to_string(),
            }
        })
        .collect()
}

/// True when a KWin session bus service is reachable.
pub fn available() -> bool {
    let Ok(conn) = Connection::session() else { return false };
    let Ok(dbus) = DBusProxy::new(&conn) else { return false };
    dbus.name_has_owner("org.kde.KWin".try_into().unwrap()).unwrap_or(false)
}

fn script_dir() -> std::path::PathBuf {
    let base = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    std::path::PathBuf::from(base).join("conduit")
}

/// unloadScript (idempotent) → loadScript → run. Returns the script id.
fn load_kwin_script(conn: &Connection, path: &str, plugin: &str) -> anyhow::Result<i32> {
    let scripting = Proxy::new(conn, "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting")?;
    let _ = scripting.call_method("unloadScript", &(plugin,)); // ok if not loaded
    let id: i32 = scripting.call("loadScript", &(path, plugin))?;
    anyhow::ensure!(id >= 0, "KWin loadScript returned {id}");
    // Plasma 6 exposes /Scripting/ScriptN; Plasma 5 exposed /N.
    for obj in [format!("/Scripting/Script{id}"), format!("/{id}")] {
        if let Ok(script) = Proxy::new(conn, "org.kde.KWin", obj.as_str(), "org.kde.kwin.Script") {
            if script.call_method("run", &()).is_ok() {
                return Ok(id);
            }
        }
    }
    anyhow::bail!("could not run KWin script {id}")
}

fn unload_kwin_script(conn: &Connection, plugin: &str) {
    if let Ok(scripting) = Proxy::new(conn, "org.kde.KWin", "/Scripting", "org.kde.kwin.Scripting") {
        let _ = scripting.call_method("unloadScript", &(plugin,));
    }
}

pub struct KdeBackend;

impl KdeBackend {
    pub fn new() -> Option<Self> {
        available().then_some(KdeBackend)
    }
}

impl FocusBackend for KdeBackend {
    fn run(self: Box<Self>, tx: Sender<Msg>) {
        let mut backoff = std::time::Duration::from_secs(1);
        loop {
            match run_once(&tx) {
                Ok(()) => return, // channel closed: daemon shutdown
                Err(e) => {
                    eprintln!("conduit/focus/kde: {e}; retrying in {}s", backoff.as_secs());
                    std::thread::sleep(backoff);
                    backoff = super::next_backoff(backoff);
                }
            }
        }
    }
}

/// Claim the service, serve the iface, inject the script, then block on
/// NameOwnerChanged to re-inject when KWin restarts.
fn run_once(tx: &Sender<Msg>) -> anyhow::Result<()> {
    let iface = FocusIface { focus_tx: Some(tx.clone()), winlist_tx: None };
    let conn = connection::Builder::session()?
        .name(SERVICE)?
        .serve_at(OBJ_PATH, iface)?
        .build()?;

    let dir = script_dir();
    std::fs::create_dir_all(&dir)?;
    let script_path = dir.join("kwin-focus.js");
    std::fs::write(&script_path, FOCUS_SCRIPT.replace("{{SERVICE}}", SERVICE))?;
    load_kwin_script(&conn, &script_path.to_string_lossy(), "conduit-focus")?;
    eprintln!("conduit/focus/kde: KWin script loaded");

    let dbus = DBusProxy::new(&conn)?;
    let changed = dbus.receive_name_owner_changed()?;
    for signal in changed {
        let args = signal.args()?;
        if args.name().as_str() == "org.kde.KWin" && args.new_owner().is_some() {
            eprintln!("conduit/focus/kde: KWin restarted; re-injecting script");
            load_kwin_script(&conn, &script_path.to_string_lossy(), "conduit-focus")?;
        }
    }
    anyhow::bail!("D-Bus signal stream ended")
}

/// One-shot window list: temporary connection + service, inject WINLIST_SCRIPT,
/// wait ≤2 s for the callback, unload. Errors → empty vec (logged).
pub fn list_windows() -> Vec<FocusInfo> {
    match list_windows_inner() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("conduit/focus/kde: list_windows: {e}");
            Vec::new()
        }
    }
}

fn list_windows_inner() -> anyhow::Result<Vec<FocusInfo>> {
    let (reply_tx, reply_rx) = mpsc::channel();
    let iface = FocusIface { focus_tx: None, winlist_tx: Some(reply_tx) };
    let conn = connection::Builder::session()?
        .name(WINLIST_SERVICE)?
        .serve_at(OBJ_PATH, iface)?
        .build()?;

    let dir = script_dir();
    std::fs::create_dir_all(&dir)?;
    let script_path = dir.join("kwin-winlist.js");
    std::fs::write(&script_path, WINLIST_SCRIPT.replace("{{SERVICE}}", WINLIST_SERVICE))?;
    load_kwin_script(&conn, &script_path.to_string_lossy(), "conduit-winlist")?;

    let result = reply_rx.recv_timeout(std::time::Duration::from_secs(2));
    unload_kwin_script(&conn, "conduit-winlist");
    Ok(result.unwrap_or_default())
}
```

**`focus/mod.rs` changes:**

- `pub mod kde;`
- Move `read_comm` from `hyprland.rs` to `mod.rs` as `pub(crate) fn read_comm(pid: u32) -> String` (hyprland imports it).
- Move `next_backoff` from `hyprland.rs` to `mod.rs` (`pub fn`); hyprland re-imports.
- Pure backend selection + detect:

```rust
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum BackendKind { Hyprland, Kde, X11, None }

/// Pure priority decision (unit-testable): Hyprland → KDE (Wayland + KWin) → X11 → none.
pub fn select_backend(hypr_sig: &str, wayland_display: &str, kwin_available: bool, display: &str) -> BackendKind {
    if !hypr_sig.is_empty() {
        return BackendKind::Hyprland;
    }
    if !wayland_display.is_empty() && kwin_available {
        return BackendKind::Kde;
    }
    if !display.is_empty() {
        return BackendKind::X11;
    }
    BackendKind::None
}
```

`detect()` and `list_windows()` dispatch on `select_backend(&env("HYPRLAND_INSTANCE_SIGNATURE"), &env("WAYLAND_DISPLAY"), kde::available(), &env("DISPLAY"))` — only call `kde::available()` when `WAYLAND_DISPLAY` is non-empty and the Hyprland arm didn't win. Keep the existing log lines pattern.

- [ ] **Step 1: Add dependency**: in `crates/conduit-daemon/Cargo.toml` add `zbus = "5"`. Run `cargo build -p conduit-daemon` to vet the version resolves.
- [ ] **Step 2: Failing tests** in `kde.rs` and `mod.rs`:

```rust
// kde.rs tests
#[test]
fn scripts_reference_the_dbus_interface() {
    for s in [FOCUS_SCRIPT, WINLIST_SCRIPT] {
        assert!(s.contains("callDBus"));
        assert!(s.contains("org.conduit.Focus"));
        assert!(s.contains("{{SERVICE}}"));
    }
    assert!(FOCUS_SCRIPT.contains("windowActivated"));   // Plasma 6
    assert!(FOCUS_SCRIPT.contains("clientActivated"));   // Plasma 5 fallback
    assert!(FOCUS_SCRIPT.contains("captionChanged"));    // live title tracking
    assert!(WINLIST_SCRIPT.contains("windowList"));
}

#[test]
fn parse_window_list_happy_and_malformed() {
    let wins = parse_window_list(r#"[{"title":"T","class":"firefox","pid":0}]"#);
    assert_eq!(wins.len(), 1);
    assert_eq!(wins[0].class, "firefox");
    assert_eq!(wins[0].title, "T");
    assert!(parse_window_list("not json").is_empty());
    assert!(parse_window_list("{}").is_empty());
}

// mod.rs tests
#[test]
fn backend_priority() {
    use BackendKind::*;
    assert_eq!(select_backend("sig", "wayland-0", true, ":0"), Hyprland);
    assert_eq!(select_backend("", "wayland-0", true, ":0"), Kde);
    assert_eq!(select_backend("", "wayland-0", false, ":0"), X11); // Wayland w/o KWin → X11 fallback
    assert_eq!(select_backend("", "", true, ":0"), X11);           // KDE on X11 stays X11
    assert_eq!(select_backend("", "", false, ""), None);
}
```

- [ ] **Step 3: Run** `cargo test -p conduit-daemon focus` — FAIL → implement per skeleton above → PASS.
- [ ] **Step 4: Add the ignored live test** (bottom of `kde.rs`):

```rust
/// Live end-to-end check against the real KWin. Run manually:
///   cargo test -p conduit-daemon -- focus::kde::tests::live_kde_verification --ignored --nocapture
#[test]
#[ignore]
fn live_kde_verification() {
    assert!(available(), "KWin not reachable on the session bus");
    let wins = list_windows();
    println!("list_windows() returned {} windows:", wins.len());
    for w in &wins {
        println!("  process={:?} class={:?} title={:?}", w.process, w.class, w.title);
    }
    assert!(!wins.is_empty(), "expected at least one window on a live desktop");
}
```

- [ ] **Step 5: Run** `cargo test --workspace` (PASS) and the live test on the KDE machine (PASS, windows printed).
- [ ] **Step 6: Commit** `feat(daemon): KDE Wayland focus backend via KWin scripting D-Bus`

---

### Task 8: UI — device classes, grab_all_mice, selector-aware Devices screen

**Files:**
- Modify: `ui/src/lib/config-model.ts`
- Modify: `ui/src/screens/Devices.tsx`
- Create: `ui/src/lib/config-model.test.ts` (extend if exists)

**Interfaces:**
- Consumes: `DeviceInfo.{id, class, phys}` (Task 6).
- Produces: `getDeviceGrabs` gains `grabAllMice: boolean`; new `selectorMatches(entry: string, dev: {name: string; vendor: number; product: number}): boolean` and `listMatchesDevice(list: string[], dev): boolean`; `setMouseGrab(m, dev: DeviceInfo, grabbed)` and `setKeyboardGrab(m, dev: DeviceInfo, grabbed, currentlyGrabbed)` write `dev.id` for additions but remove **any** matching selector form on removal.

- [ ] **Step 1: Failing vitest** in `ui/src/lib/config-model.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import {
  parseConfigToml, getDeviceGrabs, selectorMatches, listMatchesDevice,
  setMouseGrab, serializeConfigToml,
} from "./config-model";

const dev = { name: "G600", vendor: 0x046d, product: 0xc24a };

describe("device selectors", () => {
  it("matches name, vid:pid, and vid:pid/name forms", () => {
    expect(selectorMatches("G600", dev)).toBe(true);
    expect(selectorMatches("046d:c24a", dev)).toBe(true);
    expect(selectorMatches("046d:c24a/G600", dev)).toBe(true);
    expect(selectorMatches("046d:ffff", dev)).toBe(false);
    expect(selectorMatches("046d:c24a/Other", dev)).toBe(false);
    expect(selectorMatches("Other", dev)).toBe(false);
  });

  it("grab_all_mice round-trips and setMouseGrab writes canonical id", () => {
    const m = parseConfigToml("[devices]\ngrab_all_mice = true");
    expect(getDeviceGrabs(m).grabAllMice).toBe(true);

    const m2 = setMouseGrab(parseConfigToml(""), { ...dev, id: "046d:c24a/G600" }, true);
    expect(getDeviceGrabs(m2).grabMice).toEqual(["046d:c24a/G600"]);
    expect(serializeConfigToml(m2)).toContain("046d:c24a/G600");

    // Removal drops any selector form matching the device.
    const m3 = parseConfigToml('[devices]\ngrab_mice = ["G600", "046d:c24a"]');
    const m4 = setMouseGrab(m3, { ...dev, id: "046d:c24a/G600" }, false);
    expect(getDeviceGrabs(m4).grabMice).toEqual([]);
  });

  it("listMatchesDevice", () => {
    expect(listMatchesDevice(["046d:c24a"], dev)).toBe(true);
    expect(listMatchesDevice(["nope"], dev)).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `cd ui && npx vitest run --maxWorkers=2 src/lib/config-model.test.ts` — FAIL.
- [ ] **Step 3: Implement in config-model.ts:**

```typescript
export interface DeviceIdent {
  name: string;
  vendor: number;
  product: number;
}

function parseVidPid(s: string): [number, number] | null {
  const m = /^([0-9a-fA-F]{4}):([0-9a-fA-F]{4})$/.exec(s);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16)];
}

/** Mirror of the daemon's DeviceSelector grammar: name | vid:pid | vid:pid/name */
export function selectorMatches(entry: string, dev: DeviceIdent): boolean {
  const slash = entry.indexOf("/");
  if (slash > 0) {
    const vp = parseVidPid(entry.slice(0, slash));
    if (vp) {
      return vp[0] === dev.vendor && vp[1] === dev.product && entry.slice(slash + 1) === dev.name;
    }
  }
  const vp = parseVidPid(entry);
  if (vp) return vp[0] === dev.vendor && vp[1] === dev.product;
  return entry === dev.name;
}

export function listMatchesDevice(list: string[], dev: DeviceIdent): boolean {
  return list.some((e) => selectorMatches(e, dev));
}
```

`getDeviceGrabs` adds `grabAllMice: (d["grab_all_mice"] as boolean | undefined) ?? false`. Change `setMouseGrab(m, dev: DeviceIdent & { id: string }, grabbed)`:

```typescript
export function setMouseGrab(
  m: ConfigModel,
  dev: DeviceIdent & { id: string },
  grabbed: boolean
): ConfigModel {
  const d = { ...m.devices };
  const current = (d["grab_mice"] as string[] | undefined) ?? [];
  if (grabbed) {
    d["grab_mice"] = listMatchesDevice(current, dev) ? [...current] : [...current, dev.id];
  } else {
    d["grab_mice"] = current.filter((e) => !selectorMatches(e, dev));
  }
  return { ...m, devices: d };
}
```

`setKeyboardGrab` keeps its signature but takes `dev: DeviceIdent & { id: string }` instead of `name: string`; explicit-list add pushes `dev.id`, removal filters with `selectorMatches`, and the grab_all→explicit conversion writes the *ids* of currently-grabbed keyboards (Devices.tsx passes ids instead of names).

- [ ] **Step 4: Update Devices.tsx:**
  - Badge cell renders `dev.class`: `<span className={`dev-badge dev-badge--${dev.class}`}>{label}</span>` where `label` maps class → `Keyboard/Mouse/Touchpad/Gamepad/Media/Other` (a small `CLASS_LABELS: Record<string,string>` const). Touchpad/Gamepad/Media reuse the `dev-badge--other` visual style via a fallback class if no specific CSS exists — add CSS rules in `App.css` next to existing `.dev-badge--*` rules mirroring their pattern.
  - Grabbed-state derivation uses `listMatchesDevice(grabs.grabMice, dev)` / `listMatchesDevice(grabs.grabKeyboards, dev)`, and `grabs.grabAllMice ||` for mice (touchpads: list match only — mirror daemon rules; `canToggle` becomes `dev.class === "keyboard" || dev.class === "mouse" || dev.class === "touchpad"`).
  - `currentlyGrabbed` for the keyboard conversion maps to `d.id` instead of `d.name`.
  - New banner row above the table with a `grab_all_mice` checkbox, mirroring the `grab_all_keyboards` info banner:

```tsx
<label className="grab-toggle" style={{ fontSize: 12 }}>
  <input
    type="checkbox"
    checked={grabs?.grabAllMice ?? false}
    disabled={!config}
    onChange={(e) => {
      if (!config) return;
      const d = { ...config.devices, grab_all_mice: e.target.checked };
      applyConfig({ ...config, devices: d });
    }}
  />
  {" Grab all mice automatically ("}<code>grab_all_mice</code>{") — touchpads excluded"}
</label>
```

- [ ] **Step 5: Run** `cd ui && npx vitest run --maxWorkers=2 && npx tsc --noEmit` — PASS.
- [ ] **Step 6: Commit** `feat(ui): device class badges, grab_all_mice, selector-aware grabs`

---

### Task 9: UI — profile ↔ application match editor

**Files:**
- Create: `ui/src/components/ProfileMatchEditor.tsx`
- Create: `ui/src/components/ProfileMatchEditor.test.tsx`
- Modify: `ui/src/lib/config-model.ts` (`setProfileMatch`)
- Modify: `ui/src/screens/Mappings.tsx` (mount in the no-key-selected inspector slot)

**Interfaces:**
- Consumes: `listWindows()` from `ui/src/lib/client.ts`, `FocusInfo {process, class, title}`.
- Produces: `setProfileMatch(m: ConfigModel, profileName: string, match: Record<string,string> | undefined): ConfigModel` (empty-string values dropped; empty object → `undefined` → `match` table removed from TOML); `<ProfileMatchEditor model profileName onApply(match) />`.

- [ ] **Step 1: Failing vitest** — config-model part in `config-model.test.ts`:

```typescript
import { setProfileMatch } from "./config-model";

it("setProfileMatch writes, updates, and clears the match table", () => {
  const m = parseConfigToml('[profile.game]\nmatch = { class = "steam" }\n[profile.game.keys]\na = "b"');
  const m2 = setProfileMatch(m, "game", { class: "steam_app_123", title: "Elden" });
  expect(m2.profiles[0].match).toEqual({ class: "steam_app_123", title: "Elden" });
  // empty strings dropped
  const m3 = setProfileMatch(m, "game", { class: "x", process: "" });
  expect(m3.profiles[0].match).toEqual({ class: "x" });
  // all empty → removed
  const m4 = setProfileMatch(m, "game", {});
  expect(m4.profiles[0].match).toBeUndefined();
  expect(serializeConfigToml(m4)).not.toContain("match");
  // unknown profile → unchanged
  expect(setProfileMatch(m, "nope", { class: "x" })).toBe(m);
});
```

Component test `ProfileMatchEditor.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProfileMatchEditor } from "./ProfileMatchEditor";
import { parseConfigToml } from "../lib/config-model";

vi.mock("../lib/client", () => ({
  listWindows: vi.fn(async () => [
    { process: "firefox", class: "org.mozilla.firefox", title: "Home" },
  ]),
}));

describe("ProfileMatchEditor", () => {
  it("shows current match and applies edits", () => {
    const model = parseConfigToml('[profile.game]\nmatch = { class = "steam" }');
    const onApply = vi.fn();
    render(<ProfileMatchEditor model={model} profileName="game" onApply={onApply} />);
    const classInput = screen.getByLabelText("class") as HTMLInputElement;
    expect(classInput.value).toBe("steam");
    fireEvent.change(classInput, { target: { value: "steam_app_1" } });
    fireEvent.click(screen.getByText("Apply match"));
    expect(onApply).toHaveBeenCalledWith({ class: "steam_app_1" });
  });

  it("picker fills fields from a running window", async () => {
    const model = parseConfigToml("[profile.game.keys]\na = \"b\"");
    render(<ProfileMatchEditor model={model} profileName="game" onApply={() => {}} />);
    fireEvent.click(screen.getByText("Pick from open windows"));
    const item = await screen.findByText("org.mozilla.firefox");
    fireEvent.click(item);
    expect((screen.getByLabelText("class") as HTMLInputElement).value).toBe("org.mozilla.firefox");
    expect((screen.getByLabelText("process") as HTMLInputElement).value).toBe("firefox");
  });

  it("hides itself for the default profile", () => {
    const model = parseConfigToml("[profile.default.keys]\na = \"b\"");
    const { container } = render(<ProfileMatchEditor model={model} profileName="default" onApply={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});
```

- [ ] **Step 2: Run** `cd ui && npx vitest run --maxWorkers=2` — FAIL.
- [ ] **Step 3: Implement.**

`setProfileMatch` in config-model.ts:

```typescript
export function setProfileMatch(
  m: ConfigModel,
  profileName: string,
  match: Record<string, string> | undefined
): ConfigModel {
  const profIdx = m.profiles.findIndex((p) => p.name === profileName);
  if (profIdx === -1) return m;
  const cleaned = Object.fromEntries(
    Object.entries(match ?? {}).filter(([, v]) => v.trim() !== "")
  );
  const next = Object.keys(cleaned).length > 0 ? cleaned : undefined;
  const profiles = m.profiles.map((p, i) => (i === profIdx ? { ...p, match: next } : p));
  return { ...m, profiles };
}
```

`ProfileMatchEditor.tsx` — controlled inputs for class/process/title seeded from the profile's match, an Apply button calling `onApply(fields)`, and an inline window picker (fetch on demand via `listWindows()`, click fills class+process). Returns `null` for `profileName === "default"`. Styling: reuse `.inspector`, `.inspector__field-label`, `.btn`, `.window-list` classes.

```tsx
import { useState } from "react";
import { listWindows } from "../lib/client";
import type { FocusInfo } from "../lib/client";
import type { ConfigModel } from "../lib/config-model";

interface Props {
  model: ConfigModel;
  profileName: string;
  onApply: (match: Record<string, string>) => void;
}

const FIELDS = ["class", "process", "title"] as const;

export function ProfileMatchEditor({ model, profileName, onApply }: Props) {
  const prof = model.profiles.find((p) => p.name === profileName);
  const [fields, setFields] = useState<Record<string, string>>(() => ({
    class: prof?.match?.["class"] ?? "",
    process: prof?.match?.["process"] ?? "",
    title: prof?.match?.["title"] ?? "",
  }));
  const [windows, setWindows] = useState<FocusInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!prof || profileName === "default") return null;

  const openPicker = async () => {
    setLoading(true);
    setError(null);
    try {
      setWindows(await listWindows());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const pick = (w: FocusInfo) => {
    setFields((f) => ({ ...f, class: w.class, process: w.process }));
    setWindows(null);
  };

  const apply = () => {
    const out: Record<string, string> = {};
    for (const k of FIELDS) if (fields[k].trim() !== "") out[k] = fields[k].trim();
    onApply(out);
  };

  return (
    <div className="inspector">
      <div className="inspector__field-label">
        Match — link “{profileName}” to an application
      </div>
      {FIELDS.map((k) => (
        <label key={k} className="inspector__field-label" style={{ display: "block" }}>
          {k}
          <input
            aria-label={k}
            className="new-layer-input"
            type="text"
            value={fields[k]}
            placeholder={k === "title" ? "regex, e.g. .*YouTube.*" : ""}
            onChange={(e) => setFields((f) => ({ ...f, [k]: e.target.value }))}
          />
        </label>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn btn--primary" onClick={apply}>Apply match</button>
        <button className="btn" onClick={openPicker}>Pick from open windows</button>
      </div>
      {loading && <div className="muted">Loading windows…</div>}
      {error && <div className="banner--error">{error}</div>}
      {windows && (
        <ul className="window-list">
          {windows.map((w, i) => (
            <li key={i}>
              <button className="window-list__item" onClick={() => pick(w)}>
                <span className="window-list__class">{w.class}</span>
                <span className="window-list__title muted"> — {w.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

Mount in `Mappings.tsx` — replace the no-key-selected `<div className="inspector">…hint…</div>` block with:

```tsx
) : (
  <>
    <ProfileMatchEditor
      model={model}
      profileName={railActiveProfile}
      onApply={async (match) => {
        const updated = setProfileMatch(model, railActiveProfile, match);
        setModel(updated);
        try {
          await setConfig(serializeConfigToml(updated));
        } catch (err) {
          setLoadError(String(err));
        }
      }}
    />
    <div className="inspector">
      <div className="inspector__hint">Select a key above to edit its mapping.</div>
    </div>
  </>
)}
```

(Import `ProfileMatchEditor` and `setProfileMatch`; `key={railActiveProfile}` on the editor so field state resets on profile switch.)

- [ ] **Step 4: Run** `cd ui && npx vitest run --maxWorkers=2 && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(ui): profile match editor with window picker`

---

### Task 10: Docs + full verification

**Files:**
- Modify: `README.md` (features list: KDE Wayland per-app profiles; wheel remapping; grab_all_mice; selector syntax)

- [ ] **Step 1: README** — update the per-app profiles bullet to `(Hyprland, KDE Plasma Wayland, and X11 supported)`, add bullets for wheel remapping (`wheelup`/`wheeldown`/`wheelleft`/`wheelright`), `grab_all_mice`, and a short "Device selectors" subsection documenting the three grammar forms with the G600 example.
- [ ] **Step 2: Full test sweep** — `cargo test --workspace` PASS; `cd ui && npx vitest run --maxWorkers=2` PASS; `npx tsc --noEmit` PASS; `cargo build --release -p conduit-daemon` PASS.
- [ ] **Step 3: Live verification on the KDE machine** — `cargo test -p conduit-daemon -- focus::kde::tests::live_kde_verification --ignored --nocapture` prints the real window list and passes.
- [ ] **Step 4: Commit** `docs: KDE Wayland, mouse, and device selector documentation`

---

## Self-Review Notes

- Spec coverage: KDE backend (T7), wheel+grab_all_mice (T1/T2/T5/T8), classification+selectors (T3/T4/T6/T8), match editor (T9), docs+live verification (T10). ✓
- Type consistency: `Discovered.is_keyboard()/is_mouse()` are methods after T4 — T6's DeviceInfo builders use method-call syntax. `spawn_reader`'s `is_pointer` renamed in T4, consumed in T5. `select_backend` signature matches its test. ✓
- `keys::name(Key(760))` returns `"wheelup"` automatically via the KEYS table — KeyTester shows wheel events with no extra work. ✓
