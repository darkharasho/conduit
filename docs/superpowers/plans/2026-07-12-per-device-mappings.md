# Per-Device Mappings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mappings can differ per physical device (including two identical mice), and the Mappings screen organizes by device tabs with a proper mouse visualization.

**Architecture:** Config compiles `profile.device."<selector>"` sections into per-slot shadow tables (`device_selectors` union defines slot indices). Readers stamp events with a source id; the runloop resolves source→slot against the live config; `Engine::handle_on(ev, slot)` checks the device table before the global table per active layer. UI: device tabs above the viz, `MouseViz` for mouse-class devices, "This device only" scope in the inspector.

**Tech Stack:** Rust (conduit-core/daemon/proto), React + TypeScript + vitest (smol-toml).

**Spec:** `docs/superpowers/specs/2026-07-12-per-device-mappings-design.md`

## Global Constraints

- vitest MUST run with `--maxWorkers=2` or lower.
- Cargo commands need `export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig` (linuxbrew pkg-config shadows system).
- Selector specificity: `vid:pid/name@phys` (4) > `vid:pid/name` (3) > name (2) > `vid:pid` (1); ties → first (lowest index) in config order.
- `@phys` suffix recognized ONLY when the prefix parses as `vid:pid` or `vid:pid/name`.
- Existing configs (no device sections) must compile and behave identically.
- `cargo test --workspace` before each commit.

---

### Task 1: conduit-core — compile device override sections

**Files:**
- Modify: `crates/conduit-core/src/config.rs`

**Interfaces:**
- Produces: `CompiledConfig.device_selectors: Vec<String>` (union across profiles, first-seen order; index = slot); `CompiledProfile.device_layers: Vec<Option<Vec<LayerMap>>>` (outer indexed by slot; inner indexed like `layers`, 0 = base, same length as `layer_names`).

- [ ] **Step 1: Failing tests** (append to config.rs tests):

```rust
const DEV_TOML: &str = r#"
    [profile.default.keys]
    a = "b"
    [profile.default.layers.nav]
    h = "left"
    [profile.default.device."046d:c24a/G600".keys]
    btn_left = "enter"
    [profile.default.device."046d:c24a/G600".layers.nav]
    mouse4 = "volumeup"
    [profile.game]
    match = { class = "steam" }
    [profile.game.device."My Kbd".keys]
    a = "passthrough"
"#;

#[test]
fn device_sections_compile_with_global_slots() {
    let c = compile(DEV_TOML).unwrap();
    assert_eq!(c.device_selectors, vec!["046d:c24a/G600".to_string(), "My Kbd".to_string()]);
    let def = &c.profiles[c.default_idx];
    let g600 = def.device_layers[0].as_ref().expect("default has G600 section");
    assert_eq!(g600.len(), def.layer_names.len());
    let btn_left = keys::from_name("btn_left").unwrap();
    assert_eq!(g600[0][btn_left.0 as usize], Some(Action::Key(keys::from_name("enter").unwrap())));
    let nav_idx = def.layer_names.iter().position(|n| n == "nav").unwrap();
    let mouse4 = keys::from_name("mouse4").unwrap();
    assert_eq!(g600[nav_idx][mouse4.0 as usize], Some(Action::Key(keys::from_name("volumeup").unwrap())));
    assert!(def.device_layers[1].is_none()); // default has no "My Kbd" section
    let game = c.profiles.iter().find(|p| p.name == "game").unwrap();
    assert!(game.device_layers[0].is_none());
    assert!(game.device_layers[1].is_some());
}

#[test]
fn device_section_unknown_layer_rejected() {
    let err = compile(r#"[profile.default.device."X".layers.nope]
a = "b""#).unwrap_err();
    assert!(matches!(err, ConfigError::UnknownLayer { .. }));
}

#[test]
fn device_section_unknown_key_rejected() {
    let err = compile(r#"[profile.default.device."X".keys]
notakey = "b""#).unwrap_err();
    assert!(matches!(err, ConfigError::UnknownKey { .. }));
}

#[test]
fn no_device_sections_yields_empty_selectors() {
    let c = compile("[profile.default.keys]\na = \"b\"").unwrap();
    assert!(c.device_selectors.is_empty());
    assert!(c.profiles[c.default_idx].device_layers.is_empty());
}
```

- [ ] **Step 2:** `cargo test -p conduit-core device_section` — FAIL (fields missing).
- [ ] **Step 3: Implement.**

Raw layer:

```rust
#[derive(Deserialize, Default)]
struct RawDeviceOverride {
    #[serde(default)]
    keys: IndexMap<String, RawAction>,
    #[serde(default)]
    layers: IndexMap<String, IndexMap<String, RawAction>>,
}
```

`RawProfile` gains `#[serde(default)] device: IndexMap<String, RawDeviceOverride>,`.
`CompiledProfile` gains `pub device_layers: Vec<Option<Vec<LayerMap>>>,` (initialize empty where profiles are constructed). `CompiledConfig` gains `pub device_selectors: Vec<String>,`.

After the existing profile-compilation loop in `compile`:

```rust
// ── Device override sections ────────────────────────────────────────────
// Union of selector strings across profiles, first-seen order = slot index.
let mut device_selectors: Vec<String> = Vec::new();
for raw_profile in profiles.values() {
    for sel in raw_profile.device.keys() {
        if !device_selectors.iter().any(|s| s == sel) {
            device_selectors.push(sel.clone());
        }
    }
}
for compiled in compiled_profiles.iter_mut() {
    let raw_profile = &profiles[compiled.name.as_str()];
    let mut dev_layers: Vec<Option<Vec<LayerMap>>> = vec![None; device_selectors.len()];
    for (sel, ovr) in &raw_profile.device {
        let slot = device_selectors.iter().position(|s| s == sel).unwrap();
        let mut tables: Vec<LayerMap> = (0..compiled.layer_names.len())
            .map(|_| new_layer_map())
            .collect();
        let ctx = format!("{}.device.{}", compiled.name, sel);
        for (key_name, raw_action) in &ovr.keys {
            let key = keys::from_name(key_name).ok_or_else(|| ConfigError::UnknownKey {
                profile: ctx.clone(), name: key_name.clone(),
            })?;
            // reuse the same bounds check + action parsing as global keys
            let action = compile_raw_action(raw_action, &ctx, &compiled.layer_names, tap_hold_timeout_us)?;
            tables[0][key.0 as usize] = Some(action);
        }
        for (layer_name, layer_keys) in &ovr.layers {
            let li = compiled.layer_names.iter().position(|n| n == layer_name)
                .ok_or_else(|| ConfigError::UnknownLayer { profile: ctx.clone(), name: layer_name.clone() })?;
            for (key_name, raw_action) in layer_keys {
                let key = keys::from_name(key_name).ok_or_else(|| ConfigError::UnknownKey {
                    profile: ctx.clone(), name: key_name.clone(),
                })?;
                let action = compile_raw_action(raw_action, &ctx, &compiled.layer_names, tap_hold_timeout_us)?;
                tables[li][key.0 as usize] = Some(action);
            }
        }
        dev_layers[slot] = Some(tables);
    }
    compiled.device_layers = dev_layers;
}
```

Adaptation note (the executor reads the real file): the existing compile flow parses actions with an inline closure and builds `LayerMap`s with a local helper. Extract those into module-level `fn compile_raw_action(raw: &RawAction, ctx: &str, layer_names: &[String], default_timeout_us: u64) -> Result<Action, ConfigError>` and `fn new_layer_map() -> LayerMap` so the device pass reuses them verbatim (layer references inside device actions — `"layer:nav"` and tap-hold `hold = "layer:nav"` — resolve against the same `layer_names`). Bounds (`KEY_TABLE_SIZE`) checks come along for free inside `compile_raw_action`'s key parsing callers, matching global-section behavior.

- [ ] **Step 4:** `cargo test --workspace` — PASS (existing tests confirm no behavior change).
- [ ] **Step 5: Commit** `feat(core): compile per-device override sections`

---

### Task 2: conduit-core — engine device-slot lookup

**Files:**
- Modify: `crates/conduit-core/src/engine.rs`

**Interfaces:**
- Produces: `Engine::handle_on(&mut self, ev: Event, slot: Option<u16>) -> &[Event]`. `handle(ev)` stays as `handle_on(ev, None)` (all existing call sites/tests unchanged). Buffered tap-hold events replay with their original slot; `swap_config` replays its buffer with `None` (slot indices may differ under the new config).

- [ ] **Step 1: Failing tests:**

```rust
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
    // same layer, keyboard event (no slot) → global nav mapping
    assert_eq!(e.handle_on(press("h", 420_000), None), &[press("left", 420_000)]);
}

#[test]
fn buffered_events_replay_with_their_slot() {
    // tap-hold pending on the device; a device-mapped key buffered behind it
    // must resolve through the DEVICE table when replayed.
    let mut e = engine(DEV_ENGINE);
    e.handle_on(press("f", 0), Some(0));          // pending tap-hold (device table)
    e.handle_on(press("a", 50_000), Some(0));     // buffered with slot 0
    // release f before timeout → tap; buffered 'a' replays as device-mapped 'c'
    assert_eq!(e.handle_on(release("f", 100_000), Some(0)),
               &[press("f", 0), release("f", 100_000), press("a", 50_000).map_key("c")]);
}

#[test]
fn out_of_range_slot_is_global() {
    let mut e = engine(DEV_ENGINE);
    assert_eq!(e.handle_on(press("a", 0), Some(99)), &[press("b", 0)]);
}
```

(`map_key` doesn't exist — write the expectation as `Event { key: key("c"), state: KeyState::Press, time_us: 50_000 }` in the real test.)

- [ ] **Step 2:** `cargo test -p conduit-core engine` — FAIL.
- [ ] **Step 3: Implement:**

```rust
pub fn handle(&mut self, ev: Event) -> &[Event] {
    self.handle_on(ev, None)
}

pub fn handle_on(&mut self, ev: Event, slot: Option<u16>) -> &[Event] {
    self.out.clear();
    self.process(ev, slot);
    &self.out
}
```

- `buffer: Vec<Event>` → `buffer: Vec<(Event, Option<u16>)>`; `self.buffer.push((ev, slot))`; permissive-hold scan uses `b.0`; `resolve` drains `for (ev, slot) in std::mem::take(&mut self.buffer) { self.process(ev, slot); }`.
- `process(&mut self, ev: Event, slot: Option<u16>)`; the only use of `slot` is the Press-path `self.lookup(ev.key, slot)` (releases/repeats pair via `held`).
- `lookup`:

```rust
fn lookup(&self, key: Key, slot: Option<u16>) -> Action {
    let profile = &self.cfg.profiles[self.profile_idx];
    for &layer in self.active_layers.iter().rev() {
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
```

- `swap_config`: replay drops slots — `for (ev, _old_slot) in replay { self.process(ev, None); }` with a comment: slot indices are defined by the config being replaced.
- `do_suspend` clears the buffer as before (type change only).

- [ ] **Step 4:** `cargo test --workspace` — PASS.
- [ ] **Step 5: Commit** `feat(core): per-device shadow lookup in engine`

---

### Task 3: daemon — selector @phys + slot resolution

**Files:**
- Modify: `crates/conduit-daemon/src/classify.rs`

**Interfaces:**
- Produces: `DeviceSelector { base: SelectorBase, phys: Option<String> }` with `parse(&str)`, `matches(name, vendor, product, phys: &str) -> bool`, `specificity() -> u8` (4/3/2/1 per Global Constraints); `pub fn resolve_slot(name: &str, vendor: u16, product: u16, phys: &str, selectors: &[String]) -> Option<u16>` (most specific match; ties → lowest index).

- [ ] **Step 1: Failing tests:**

```rust
#[test]
fn selector_phys_suffix() {
    let s = DeviceSelector::parse("046d:c24a/G600@usb-1/input0");
    assert!(s.matches("G600", 0x046d, 0xc24a, "usb-1/input0"));
    assert!(!s.matches("G600", 0x046d, 0xc24a, "usb-2/input0"));
    assert_eq!(s.specificity(), 4);
    // '@' after a plain name is NOT a phys suffix
    let n = DeviceSelector::parse("Weird@Name");
    assert!(n.matches("Weird@Name", 0, 0, ""));
    // vid:pid@phys works too
    let vp = DeviceSelector::parse("046d:c24a@usb-1/input0");
    assert!(vp.matches("anything", 0x046d, 0xc24a, "usb-1/input0"));
    assert!(!vp.matches("anything", 0x046d, 0xc24a, ""));
}

#[test]
fn specificity_ranking() {
    assert_eq!(DeviceSelector::parse("046d:c24a/G600@p").specificity(), 4);
    assert_eq!(DeviceSelector::parse("046d:c24a/G600").specificity(), 3);
    assert_eq!(DeviceSelector::parse("G600").specificity(), 2);
    assert_eq!(DeviceSelector::parse("046d:c24a").specificity(), 1);
}

#[test]
fn resolve_slot_prefers_specific_then_first() {
    let sels = vec![
        "046d:c24a".to_string(),          // 0: spec 1
        "G600".to_string(),               // 1: spec 2
        "046d:c24a/G600".to_string(),     // 2: spec 3
        "046d:c24a/G600@usb-1".to_string(), // 3: spec 4
    ];
    assert_eq!(resolve_slot("G600", 0x046d, 0xc24a, "usb-1", &sels), Some(3));
    assert_eq!(resolve_slot("G600", 0x046d, 0xc24a, "usb-2", &sels), Some(2)); // phys mismatch → next
    assert_eq!(resolve_slot("Other", 0x046d, 0xc24a, "", &sels), Some(0));
    assert_eq!(resolve_slot("Nope", 1, 1, "", &sels), None);
    // tie on specificity → first in config order
    let tie = vec!["G600".to_string(), "046d:c24a/G600".to_string(), "046d:c24a/G601".to_string()];
    assert_eq!(resolve_slot("G600", 0x046d, 0xc24a, "", &tie), Some(1));
}
```

- [ ] **Step 2:** FAIL, then **Step 3: Implement** — restructure:

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectorBase {
    Name(String),
    VidPid(u16, u16),
    VidPidName(u16, u16, String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceSelector {
    pub base: SelectorBase,
    pub phys: Option<String>,
}

impl DeviceSelector {
    pub fn parse(s: &str) -> DeviceSelector {
        // @phys only counts when the prefix parses as vid:pid or vid:pid/name.
        if let Some((prefix, phys)) = s.rsplit_once('@') {
            let base = parse_base(prefix);
            if !matches!(base, SelectorBase::Name(_)) {
                return DeviceSelector { base, phys: Some(phys.to_string()) };
            }
        }
        DeviceSelector { base: parse_base(s), phys: None }
    }

    pub fn matches(&self, name: &str, vendor: u16, product: u16, phys: &str) -> bool {
        let base_ok = match &self.base {
            SelectorBase::Name(n) => n == name,
            SelectorBase::VidPid(v, p) => *v == vendor && *p == product,
            SelectorBase::VidPidName(v, p, n) => *v == vendor && *p == product && n == name,
        };
        base_ok && self.phys.as_ref().map_or(true, |ph| ph == phys)
    }

    pub fn specificity(&self) -> u8 {
        match (&self.base, &self.phys) {
            (SelectorBase::VidPidName(..), Some(_)) | (SelectorBase::VidPid(..), Some(_)) => 4,
            (SelectorBase::VidPidName(..), None) => 3,
            (SelectorBase::Name(_), _) => 2,
            (SelectorBase::VidPid(..), None) => 1,
        }
    }
}

fn parse_base(s: &str) -> SelectorBase {
    if let Some((vp, name)) = s.split_once('/') {
        if let Some((v, p)) = parse_vid_pid(vp) {
            return SelectorBase::VidPidName(v, p, name.to_string());
        }
    }
    if let Some((v, p)) = parse_vid_pid(s) {
        return SelectorBase::VidPid(v, p);
    }
    SelectorBase::Name(s.to_string())
}

/// Most specific matching selector's index; ties → first in config order.
pub fn resolve_slot(name: &str, vendor: u16, product: u16, phys: &str, selectors: &[String]) -> Option<u16> {
    selectors
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            let sel = DeviceSelector::parse(s);
            sel.matches(name, vendor, product, phys).then(|| (i, sel.specificity()))
        })
        .max_by_key(|&(i, spec)| (spec, std::cmp::Reverse(i)))
        .map(|(i, _)| i as u16)
}
```

Update `devices::should_grab`'s call to `sel.matches(&d.name, d.vendor, d.product, &d.phys)`, and rewrite the existing selector tests to the 4-arg form (pass `""` where phys is irrelevant). The old `DeviceSelector::VidPid(...)`-shaped assertions in `selector_parse_forms` become `DeviceSelector { base: SelectorBase::VidPid(...), phys: None }`.

- [ ] **Step 4:** `cargo test --workspace` — PASS. **Step 5: Commit** `feat(daemon): selector @phys suffix and slot resolution`

---

### Task 4: daemon — source tagging through the runloop

**Files:**
- Modify: `crates/conduit-daemon/src/devices.rs` (spawn_reader source param), `crates/conduit-daemon/src/runloop.rs`, `crates/conduit-daemon/src/lib.rs`, `crates/conduit-proto/src/lib.rs` (WireEvent.device), `crates/conduit-daemon/src/ipc.rs` (no changes expected; verify pattern matches), `ui/src/lib/client.ts` (WireEvent type)

**Interfaces:**
- Produces: `Msg::Input(Event, Option<u16>)` where the u16 is a **source id** (assigned at reader spawn via `devices::next_source_id()`, an `AtomicU16`); `spawn_reader(path, is_pointer, do_grab, source: u16, tx, out)`; `runloop::run(engine, out, rx, tx, readers, settings, sources: HashMap<PathBuf, SourceInfo>, device_selectors: Vec<String>)` with `pub struct SourceInfo { pub id: u16, pub name: String, pub vendor: u16, pub product: u16, pub phys: String }`; `WireEvent.device: String` (`#[serde(default)]`; source device name on pre-phase, `""` on post-phase).

- [ ] **Step 1: Failing test** (runloop.rs — drive is source-agnostic; test the slot translation helper):

```rust
#[test]
fn slot_map_recomputes_from_selectors() {
    let mut sources = HashMap::new();
    sources.insert(PathBuf::from("/dev/input/event9"), SourceInfo {
        id: 7, name: "G600".into(), vendor: 0x046d, product: 0xc24a, phys: "usb-1".into(),
    });
    let slots = compute_slots(&sources, &["046d:c24a/G600".to_string()]);
    assert_eq!(slots.get(&7), Some(&Some(0)));
    let slots = compute_slots(&sources, &[]);
    assert_eq!(slots.get(&7), Some(&None));
}
```

- [ ] **Step 2:** FAIL. **Step 3: Implement:**

devices.rs:

```rust
static NEXT_SOURCE: AtomicU16 = AtomicU16::new(0);
pub fn next_source_id() -> u16 {
    NEXT_SOURCE.fetch_add(1, Ordering::Relaxed)
}
```

`spawn_reader` gains `source: u16`; both `tx.send(Msg::Input(...))` sites (key events and wheel events) become `Msg::Input(ev, Some(source))`.

runloop.rs:

```rust
pub struct SourceInfo {
    pub id: u16,
    pub name: String,
    pub vendor: u16,
    pub product: u16,
    pub phys: String,
}

/// source id → device slot under the given selector list.
pub fn compute_slots(
    sources: &HashMap<PathBuf, SourceInfo>,
    selectors: &[String],
) -> HashMap<u16, Option<u16>> {
    sources
        .values()
        .map(|s| (s.id, crate::classify::resolve_slot(&s.name, s.vendor, s.product, &s.phys, selectors)))
        .collect()
}
```

In `run`: params gain `mut sources: HashMap<PathBuf, SourceInfo>, mut device_selectors: Vec<String>`; before the loop `let mut slots = compute_slots(&sources, &device_selectors);` and `let name_of = |sources: &HashMap<_, SourceInfo>, id: u16| ...` (helper fn returning the source name or `""`).

- `Msg::Input` pattern updates: pre-phase push + capture become `Some(Msg::Input(ev, src))`; `wire_event` gains a `device: &str` param — pre-phase passes the source name, post-phase (in `emit_all`) passes `""`.
- Input is handled directly in `run` (not via `drive`):

```rust
Some(Msg::Input(ev, src)) => {
    let slot = src.and_then(|s| slots.get(&s).copied().flatten());
    engine.handle_on(ev, slot).to_vec()
}
```

`drive()` keeps its `Msg::Input(ev, _src)` arm as `engine.handle(ev)` for its unit tests (document: production input goes through `run`'s arm).
- `Msg::Reload(cfg)`: before `swap_config`, `device_selectors = cfg.device_selectors.clone(); ` then after settings update `slots = compute_slots(&sources, &device_selectors);`.
- `try_grab_device`: gains `sources: &mut HashMap<PathBuf, SourceInfo>` + recompute; assigns `let source = crate::devices::next_source_id();`, passes it to `spawn_reader`, inserts `SourceInfo` from the `Discovered`.
- `Msg::DeviceRemoved`: `sources.remove(&p);` + recompute `slots`.
- lib.rs `start()`: build `sources` while grabbing (`next_source_id()` per device), pass `sources` and `compiled.device_selectors.clone()` into `runloop::run`.

proto: `WireEvent` gains `#[serde(default)] pub device: String,`; fix the two proto tests constructing WireEvent (`device: "".into()`), and the wire-shape assertion gains `"device":""`. `ui/src/lib/client.ts` `WireEvent` gains `device: string;`.

Existing daemon test/call-site sweep: `Msg::Input(...)` constructions in runloop tests, integration tests, and ipc.rs (CaptureNextKey path only *matches* on `Msg::Input`) get `, None` / `, _` added.

- [ ] **Step 4:** `cargo test --workspace` + `cd ui && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(daemon): per-device slots wired from readers to engine`

---

### Task 5: UI — config-model device sections + selector mirror

**Files:**
- Modify: `ui/src/lib/config-model.ts`, `ui/src/lib/config-model.test.ts`

**Interfaces:**
- Produces:
  - `ProfileModel.device?: Record<string, DeviceOverrideModel>` where `DeviceOverrideModel = { keys: Record<string, RawActionModel>; layers: Record<string, Record<string, RawActionModel>> }` (parsed/serialized round-trip).
  - `selectorMatches(entry, dev)` handles `@phys` (dev gains optional `phys?: string`); `selectorSpecificity(entry): number` (4/3/2/1).
  - `deviceSectionFor(m, profileName, dev): string | null` — the existing section key that best matches the device (specificity, ties → first).
  - `deviceSectionKey(dev, allDevices): string` — canonical `vid:pid/name`, `@phys`-suffixed iff another grabbed device shares the canonical id.
  - `getEffectiveAction(m, profileName, dev, layer, keyName): { action: ActionModel; source: "device" | "profile" } | null`.
  - `setDeviceAction(m, profileName, sectionKey, layer, keyName, action): ConfigModel` (creates section/layer as needed).
  - `removeDeviceAction(m, profileName, sectionKey, layer, keyName): ConfigModel` (prunes empty tables/sections).

- [ ] **Step 1: Failing tests:**

```typescript
const DEV_TOML = `
[profile.default.keys]
a = "b"

[profile.default.device."046d:c24a/G600".keys]
btn_left = "enter"
`;
const g600dev = { name: "G600", vendor: 0x046d, product: 0xc24a, phys: "usb-1", id: "046d:c24a/G600" };

describe("device sections", () => {
  it("round-trips profile.device through TOML", () => {
    const m = parseConfigToml(DEV_TOML);
    expect(m.profiles[0].device?.['046d:c24a/G600'].keys["btn_left"]).toBe("enter");
    expect(serializeConfigToml(m)).toContain('device."046d:c24a/G600"');
  });

  it("selector @phys and specificity", () => {
    expect(selectorMatches("046d:c24a/G600@usb-1", g600dev)).toBe(true);
    expect(selectorMatches("046d:c24a/G600@usb-2", g600dev)).toBe(false);
    expect(selectorMatches("Weird@Name", { name: "Weird@Name", vendor: 0, product: 0 })).toBe(true);
    expect(selectorSpecificity("046d:c24a/G600@usb-1")).toBe(4);
    expect(selectorSpecificity("046d:c24a/G600")).toBe(3);
    expect(selectorSpecificity("G600")).toBe(2);
    expect(selectorSpecificity("046d:c24a")).toBe(1);
  });

  it("effective action: device shadows profile, falls through otherwise", () => {
    const m = parseConfigToml(DEV_TOML);
    expect(getEffectiveAction(m, "default", g600dev, "base", "btn_left"))
      .toEqual({ action: { kind: "key", key: "enter" }, source: "device" });
    expect(getEffectiveAction(m, "default", g600dev, "base", "a"))
      .toEqual({ action: { kind: "key", key: "b" }, source: "profile" });
    expect(getEffectiveAction(m, "default", g600dev, "base", "q")).toBeNull();
  });

  it("setDeviceAction creates and removeDeviceAction prunes", () => {
    let m = parseConfigToml('[profile.default.keys]\na = "b"');
    m = setDeviceAction(m, "default", "046d:c24a/G600", "base", "mouse4", { kind: "key", key: "back" });
    expect(getEffectiveAction(m, "default", g600dev, "base", "mouse4")?.source).toBe("device");
    m = removeDeviceAction(m, "default", "046d:c24a/G600", "base", "mouse4");
    expect(m.profiles[0].device).toBeUndefined(); // fully pruned
  });

  it("deviceSectionKey appends @phys only for twins", () => {
    const twinA = { ...g600dev, phys: "usb-1" };
    const twinB = { ...g600dev, phys: "usb-2" };
    expect(deviceSectionKey(twinA, [twinA])).toBe("046d:c24a/G600");
    expect(deviceSectionKey(twinA, [twinA, twinB])).toBe("046d:c24a/G600@usb-1");
  });
});
```

- [ ] **Step 2:** FAIL. **Step 3: Implement** per the Interfaces block. Parsing: read `rp["device"]` inside `parseConfigToml`'s profile loop; serialization: emit `entry["device"]` when present (before `keys`). `selectorMatches` change: recognize `@` suffix only when the prefix's vid:pid parse succeeds (mirror Rust exactly); `getEffectiveAction` resolves the section via `deviceSectionFor` (specificity + first-wins), then layer table (`layer === "base" ? keys : layers[layer]`), then falls back to the profile's own tables (reuse `getAction`).
- [ ] **Step 4:** `cd ui && npx vitest run --maxWorkers=2 && npx tsc --noEmit` — PASS.
- [ ] **Step 5: Commit** `feat(ui): device override sections in the config model`

---

### Task 6: UI — device tabs, MouseViz, inspector scope, KeyTester device

**Files:**
- Create: `ui/src/components/MouseViz.tsx`, `ui/src/components/MouseViz.test.tsx`
- Modify: `ui/src/screens/Mappings.tsx`, `ui/src/components/KeyboardViz.tsx` (consume effective actions; drop mouse row), `ui/src/lib/keyboard-layout.ts` (delete the mouse row), `ui/src/components/InspectorPanel.tsx` (scope checkbox + remove override), `ui/src/screens/KeyTester.tsx` (device column), `ui/src/App.css` (tabs + mouse viz styles)

**Interfaces:**
- Consumes: everything from Task 5; `listDevices()` (grabbed flag, class, id, phys, vendor, product, name).
- Produces: `<MouseViz model activeProfile activeLayer selectedKey onSelectKey dev />` — renders the mouse diagram + wheel/extra chips; every control carries `data-key` with the canonical key name (`btn_left`, `btn_right`, `btn_middle`, `mouse4`, `mouse5`, `wheelup`, `wheeldown`, `wheelleft`, `wheelright`, `btn_forward`, `btn_back`, `btn_task`); mapped controls get `mousekey--mapped`, device overrides `mousekey--devspec`. Mappings gains device tabs; `InspectorPanel` gains props `{ deviceScope: boolean; onDeviceScopeChange(v: boolean): void; isDeviceOverride: boolean; onRemoveOverride(): void }`.

- [ ] **Step 1: MouseViz failing test:**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MouseViz } from "./MouseViz";
import { parseConfigToml } from "../lib/config-model";

const dev = { name: "G600", vendor: 0x046d, product: 0xc24a, phys: "", id: "046d:c24a/G600" };
const TOML = `
[profile.default.keys]
wheelup = "volumeup"
[profile.default.device."046d:c24a/G600".keys]
btn_left = "enter"
`;

describe("MouseViz", () => {
  it("marks mapped and device-specific controls, selects on click", () => {
    const model = parseConfigToml(TOML);
    const onSelect = vi.fn();
    const { container } = render(
      <MouseViz model={model} activeProfile="default" activeLayer="base"
                selectedKey={null} onSelectKey={onSelect} dev={dev} />
    );
    const m1 = container.querySelector('[data-key="btn_left"]')!;
    expect(m1.className).toContain("mousekey--mapped");
    expect(m1.className).toContain("mousekey--devspec");
    const wheel = container.querySelector('[data-key="wheelup"]')!;
    expect(wheel.className).toContain("mousekey--mapped");
    expect(wheel.className).not.toContain("mousekey--devspec");
    fireEvent.click(m1);
    expect(onSelect).toHaveBeenCalledWith("btn_left");
    // all twelve controls present
    for (const k of ["btn_left","btn_right","btn_middle","mouse4","mouse5","wheelup","wheeldown","wheelleft","wheelright","btn_forward","btn_back","btn_task"]) {
      expect(container.querySelector(`[data-key="${k}"]`)).not.toBeNull();
    }
  });
});
```

- [ ] **Step 2:** FAIL. **Step 3: Implement MouseViz** — layout mirrors the approved mockup: a rounded-rect mouse body (CSS, no SVG asset) with absolutely positioned M1/M2 (top halves), M3 (center, below the wheel chips), side M4/M5 (inside the body's left edge, not overflowing), and two labeled chip groups to the right (Wheel: wheelup/wheeldown/wheelleft/wheelright; Extra: btn_forward/btn_back/btn_task). Each control: `getEffectiveAction(model, activeProfile, dev, activeLayer, key)` → classes `mousekey`, `--mapped` when non-null, `--devspec` when `source === "device"`, `--sel` when `selectedKey === key`; `onClick={() => onSelectKey(key)}`; label shows the short name (M1…M5, chip names) plus the mapped action underneath in 9px mono (match KeyboardViz's keycap label pattern — read it and copy the idiom).
- [ ] **Step 4: Device tabs in Mappings.tsx.** State: `devices` from `listDevices()` on mount + `onConnection` refresh (grabbed only); `activeDev: string | null` (device id, default first grabbed device; null = no devices → show KeyboardViz with no device context, today's behavior minus mouse row). Tab list = grabbed devices + (config sections in the active profile with no matching grabbed device → grayed offline tabs, using the section key as the label). Render `<MouseViz>` when the active tab's `class === "mouse" || class === "touchpad"`, else `<KeyboardViz>`. KeyboardViz gains an optional `dev` prop: when set, keycap actions come from `getEffectiveAction` (device badge dot via a `keycap--devspec` class) instead of `getAction`; without `dev` it behaves as before. Delete the mouse row from `keyboard-layout.ts` and its render block in KeyboardViz.
- [ ] **Step 5: Inspector scope.** Mappings holds `deviceScope: boolean` (reset to false on key/tab change). `handleSaveAction`: if `deviceScope && activeDev` → `setDeviceAction(model, profile, deviceSectionKey(activeDevInfo, grabbedDevices), layer, key, action)` else `setAction(...)` as today. `isDeviceOverride` = `getEffectiveAction(...)?.source === "device"`; `onRemoveOverride` calls `removeDeviceAction` + persists. InspectorPanel renders (above its action buttons):

```tsx
<label className="inspector__scope">
  <input type="checkbox" checked={deviceScope} onChange={(e) => onDeviceScopeChange(e.target.checked)} />
  {" This device only"}
</label>
{isDeviceOverride && (
  <button className="btn" onClick={onRemoveOverride}>Remove override</button>
)}
```

- [ ] **Step 6: KeyTester device column** — read `KeyTester.tsx`, add a `device` cell rendering `ev.device` (pre-phase events; empty for post) in the existing event-row markup.
- [ ] **Step 7:** `cd ui && npx vitest run --maxWorkers=2 && npx tsc --noEmit` — PASS (update any KeyboardViz/keyboard-layout tests that referenced the mouse row).
- [ ] **Step 8: Commit** `feat(ui): device tabs, mouse visualization, per-device scope`

---

### Task 7: Docs + verification + ship

**Files:**
- Modify: `README.md`

- [ ] **Step 1:** README: add a "Per-device mappings" subsection under Device selectors documenting the `[profile.X.device."<selector>"]` syntax, shadowing semantics, `@phys` for twin devices, and the "This device only" UI flow.
- [ ] **Step 2:** Full sweep: `cargo test --workspace`; `cargo test -p conduit-daemon --test integration -- --ignored` (uinput end-to-end still green); `cd ui && npx vitest run --maxWorkers=2 && npx tsc --noEmit`; `cargo build --release -p conduit-daemon`.
- [ ] **Step 3:** Commit `docs: per-device mapping documentation`, push, watch CI.

---

## Self-Review Notes

- Spec coverage: config sections (T1), engine shadowing + buffered-replay slots + swap_config slot drop (T2), @phys + specificity + resolution (T3), source tagging + reload recompute + WireEvent.device (T4), config-model + effective lookup + twins key (T5), tabs/MouseViz/scope/KeyTester (T6), docs (T7). Offline-section tabs: T6 Step 4. ✓
- Type consistency: `handle_on(ev, Option<u16>)` used by T4's run arm; `resolve_slot(name, vendor, product, phys, selectors)` used by T4's `compute_slots`; `DeviceOverrideModel` shape matches T6's consumers; `SourceInfo` fields match `compute_slots`. ✓
- `drive()` keeps compiling because `Msg::Input` gains a second field handled with `_` there; production input path moves to `run`'s explicit arm. ✓
