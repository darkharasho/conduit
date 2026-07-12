# Per-device mappings and device-tab Mappings UI

**Date:** 2026-07-12
**Status:** Approved by user (mockup reviewed in-app)

## Goal

Mappings can differ per physical device — remap a G600's buttons without
touching the Wooting's identical keycodes, and map two *identical* mice
independently. The Mappings screen organizes by device tabs instead of one
keyboard visualization with a bolted-on mouse row.

## Semantics

- Global profile mappings (`[profile.X.keys]`, `[profile.X.layers.L]`) stay
  exactly as today and apply to all devices.
- A profile may add **device override sections** keyed by device selector:

```toml
[profile.default.device."046d:c24a/Logitech Gaming Mouse G600".keys]
btn_left = { tap = "enter", hold = "layer:nav" }

[profile.default.device."046d:c24a/Logitech Gaming Mouse G600".layers.nav]
mouse4 = "volumeup"
```

- Resolution for a key event from device D, in the active profile: walk the
  active layer stack top-down; at each layer check D's override table first,
  then the global table. First hit wins. (Device tables *shadow*, they do not
  replace — an unmapped key on a device falls through to the global mapping.)
- Layer names in a device section must exist in the profile (same
  `UnknownLayer` error as today). Device sections do not participate in
  profile inheritance (`inherit` copies global tables only).
- Layer state, tap-hold timing, panic chord, suspend: unchanged and global.

## Device identity

- Selector grammar gains an optional `@phys` suffix:
  `046d:c24a/G600@usb-0000:00:14.0-1/input0`. The suffix is recognized only
  when the part before `@` parses as `vid:pid` or `vid:pid/name` — plain
  names containing `@` keep working as names.
- Specificity ranking (most specific matching section wins; ties → first in
  config order): `vid:pid/name@phys` (4) > `vid:pid/name` (3) > exact name
  (2) > `vid:pid` (1).
- The UI writes plain `vid:pid/name` and appends `@phys` only when two
  grabbed devices share a canonical id (twin mice) — lone devices keep
  working when replugged into another port.

## Architecture

### conduit-core

- `config`: `RawProfile` gains `device: IndexMap<String, RawDeviceOverride>`
  (`keys` + `layers`, same action grammar). `CompiledConfig` gains
  `device_selectors: Vec<String>` — the union of selector strings across all
  profiles, in first-seen order; index = **device slot**. Each
  `CompiledProfile` gains `device_layers: Vec<Option<Vec<LayerMap>>>` indexed
  by slot (None = profile has no section for that selector), inner Vec
  indexed like `layers` (0 = base).
- `engine`: `handle(ev, slot: Option<u16>)`; buffered tap-hold events store
  their slot so replay resolves under the right device. `lookup(key, slot)`
  checks `device_layers[slot][layer]` before `layers[layer]` per active
  layer. Everything else untouched. (`Event` itself is unchanged — outputs
  carry no device.)

### conduit-daemon

- Readers get a `source: u16` at spawn (monotonic) and send
  `Msg::Input(Event, Option<u16>)` — wheel-synthesized events included.
- The runloop owns `source → slot` resolution: on startup, `DeviceAdded`, and
  `Reload` it recomputes each source's best-matching selector index against
  `CompiledConfig::device_selectors` (specificity ranking above). Engine sees
  slots only; identity stays in the daemon.
- `WireEvent` gains `device: String` (source device name on pre-phase
  events; empty on post-phase) so the Key Tester can show which device fired.

### UI

- **Device tabs** in Mappings above the viz: one per grabbed device
  (name + class chip), plus grayed tabs for offline devices that still have
  override sections. Tab key = canonical id (or id@phys for twins).
- Keyboard-class tabs render the existing ANSI `KeyboardViz` (the bolted-on
  mouse row is removed from the layout); mouse-class tabs render a new
  `MouseViz`: mouse diagram (M1/M2/M3, side M4/M5) plus chip groups for
  wheel (`wheelup/wheeldown/wheelleft/wheelright`) and extra buttons
  (`btn_forward/btn_back/btn_task`) — first UI access to wheel mapping.
- Keys show the **effective** action for the selected tab's device; an amber
  dot marks device-specific overrides.
- Inspector gains a **"This device only"** checkbox (default off). Off =
  writes global mappings exactly as today; on = writes the device section.
  When the selected key has a device override, a "Remove override" action
  deletes it (falling back to the global mapping).
- Key Tester events list shows the source device name.
- `config-model.ts`: parse/serialize `profile.device` sections;
  `getEffectiveAction(model, profile, deviceKey, layer, key) →
  {action, source: "device"|"profile"|null}`; `setDeviceAction`,
  `removeDeviceAction`.

## Error handling

- Unknown key/layer names in device sections → same compile errors as global
  sections (config rejected, live config kept).
- Events from a device matching no section → slot None → global tables only
  (today's behavior).
- Offline device with overrides → grayed tab; mappings preserved in TOML.

## Testing

- Engine: device shadowing, fallback to global, per-layer overrides,
  tap-hold buffered replay with slots, slot None behavior.
- Config: device section compile, unknown layer/key errors, selector @phys
  parse/specificity table, device_selectors slot assignment across profiles.
- Daemon: source→slot resolution (specificity, twins via phys, reload).
- UI: config-model device-section round-trip + effective lookup; device tabs
  render; scope toggle writes the right section; MouseViz selection.

## Non-goals

- Device sections in profile inheritance.
- Per-device layer *state* (layer stack stays global).
- Custom per-device keyboard geometry (ANSI board for all keyboards).
