# Conduit — Design Spec

**Date:** 2026-07-11
**Status:** Approved for planning

## What

A Linux input remapping tool: a low-latency daemon that intercepts keyboard/mouse
events at the evdev layer, translates them through a configurable state machine,
and switches mappings automatically based on the focused application — wrapped in
a polished Tauri UI. Inspired by evsieve/kanata/Karabiner-Elements; built as our
own thin engine rather than wrapping evsieve, because live per-app profile
switching and gaming-grade latency fight evsieve's static-pipeline model.

## Goals & non-goals

**Primary use case:** power-user remapping (home-row mods, layers, per-app
bindings), with latency low enough for gaming.

**Platforms:** X11 and Wayland. Wayland focus detection targets **Hyprland**
(IPC socket) in v1; other compositors are future work. The evdev/uinput layer is
display-server-agnostic.

**v1 scope:**
- Simple remaps (key→key, key→mouse-button, and vice versa)
- Tap-hold / dual-role keys (caps=esc/ctrl, home-row mods)
- Layers (while-held and toggle)
- Per-app profiles switched by focused window (X11 + Hyprland)
- Basic mouse **button** remaps

**Deferred (v1.x+):** macros/sequences, combos/chords, scroll remapping,
pointer-to-key translation, other Wayland compositors, root/system-level daemon.

## Architecture

Two processes; approach chosen over (a) a single Tauri app doing the grabbing
(remapping dies with the UI) and (b) a root daemon + polkit (overkill for a
per-user tool).

```
conduit-daemon (Rust, systemd user service)
  Device Manager ──► Remap Engine ──► Virtual Output (uinput)
        ▲                 ▲
  Config Store ───► Focus Watcher (X11 / Hyprland IPC)
        ▲
  IPC Server (Unix socket, newline-delimited JSON)
        │
conduit-ui (Tauri) — optional at runtime, stateless view
```

**Key properties:**
- **One hot path.** Physical event → engine → uinput on a single thread, no
  allocation, no IPC. Focus changes and config reloads swap a pre-compiled
  profile pointer via message; they never block a key event.
- **Grab model:** daemon `EVIOCGRAB`s selected physical devices and re-emits
  translated events through virtual uinput devices (one keyboard + one mouse).
  Unmapped keys pass through untouched.
- **Crash safety is inherent:** if the daemon dies, the kernel releases the
  grab and physical devices work again.
- **File-first config:** TOML at `~/.config/conduit/conduit.toml` is canonical
  state. The UI is a frontend to the file; hand edits hot-reload. No UI-only
  state.

**Repo layout:** Cargo workspace — `crates/conduit-core` (pure engine logic,
no I/O), `crates/conduit-daemon` (evdev/uinput/IPC/focus glue), `ui/` (Tauri).

## Remap engine (conduit-core)

Pure state machine: `(input event, clock, state) → output events`. No evdev,
no sockets — fully unit-testable with a fake clock.

**Model:**
- **Profile** — unit of per-app switching. `[profile.<name>]` with a `match`
  rule (process name, window class, or title regex). `[profile.default]`
  always exists; profiles are checked in file order (parsed order-preserving)
  and the first match wins, with `default` as fallback; `inherit = "default"`
  lets app profiles express only differences.
- **Layer** — keymap table `physical key → action`. Layer 0 is base; active
  layers form a stack; lookup walks top-down, first hit wins, miss =
  passthrough.
- **Action** — `key(X)` (keyboard keys and mouse buttons share one enum),
  `tap_hold(tap, hold, timeout_ms)`, `layer_while_held(n)`, `layer_toggle(n)`,
  `disabled`, `passthrough` (explicit identity, for punching holes in
  inherited maps).

**Tap-hold semantics:**
- Key down defers the decision; subsequent events buffer; nothing emits yet.
- **Tap** if released before `timeout_ms` (default 200).
- **Hold** if the timeout fires, or if another key is pressed *and released*
  while it's down (**permissive hold** — the QMK/kanata rule; pure timeout
  feels bad for fast typists).
- On resolution, buffered events replay in order through the decided mapping,
  carrying original timestamps (games see correct relative timing).
- Worst-case added latency = the timeout, only on tap-hold keys, only until
  resolution.

**Profile switching:** engine swaps a pre-compiled profile pointer on
`FocusChange`. Keys already held keep the mapping they were pressed under
until released — key-down and key-up always pair through the same action (no
stuck keys when alt-tabbing mid-shortcut).

**Compile step:** config load → validation → flat dense arrays indexed by
keycode. Atomic: a bad config never partially applies; the old one stays live.

## Daemon glue

**Device manager:** enumerates `/dev/input/event*`, identifies
keyboards/mice by capability bits, grabs devices matching config (by
name/vendor:product; `grab_all_keyboards = true` default). Hotplug via udev
monitor. Virtual devices are created before grabbing (never a moment with no
output path) and advertise a full capability set up front (uinput caps are
fixed after creation).

**Focus watcher:** backend trait, auto-detected from environment
(`WAYLAND_DISPLAY` + `HYPRLAND_INSTANCE_SIGNATURE` → Hyprland; else X11).
- Hyprland: subscribe to the event socket (`socket2`); on `activewindow`
  query class + PID. Push-based.
- X11: `x11rb`; watch `_NET_ACTIVE_WINDOW`, read `_NET_WM_PID` / `WM_CLASS`.
- Emits `FocusChange { process_name, window_class, title }`. On backend death
  (compositor restart): reconnect with backoff; engine stays on last profile —
  degraded, never broken.

**IPC:** Unix socket at `$XDG_RUNTIME_DIR/conduit.sock`, newline-delimited
JSON, user-owned mode 0600 (security boundary = your user).
Requests: `get_status`, `get_config`, `set_config` (validate → write TOML →
reload, atomic), `list_devices`, `subscribe_events` (live pre- and
post-mapping event stream for the key tester), `subscribe_status` (active
profile/layer changes), `suspend`/`resume`.

**Config flavor:**

```toml
[settings]
tap_hold_timeout = 200
panic_chord = ["leftctrl", "leftalt", "backspace"]

[devices]
grab_all_keyboards = true
grab_mice = ["Logitech G502"]

[profile.default.keys]
capslock = { tap = "esc", hold = "leftctrl" }
f = { tap = "f", hold = "layer:nav" }

[profile.default.layers.nav]
h = "left"
j = "down"
k = "up"
l = "right"

[profile.firefox]
match = { class = "firefox" }
inherit = "default"
keys = { mouse4 = "back" }
```

## UI (Tauri)

Four screens:
1. **Mappings** (home) — profile list, layers as tabs, rendered keyboard
   visualization; click a key → action editor popover. Mouse buttons rendered
   alongside.
2. **Key tester** — live stream: what you pressed vs. what apps received,
   plus tap-hold resolution timing. Primary debugging feature.
3. **Devices** — detected devices, per-device grab toggles, hotplug status.
4. **Status/settings** — daemon health, live active profile, suspend/resume,
   timeouts, panic chord.

Plumbing:
- Tauri Rust backend is a thin socket client; frontend gets typed events via
  Tauri's event system. All state lives in the daemon.
- **Key capture** for remap editing goes through the daemon ("tag the next
  physical event"), not browser key events — works for keys the browser can't
  see and is immune to the user's own active remaps.
- Per-app profile creation picks from currently running windows (daemon
  supplies the list) rather than requiring a typed window class.
- Edits apply via `set_config`, validated, live immediately; validation errors
  render inline.

## Error handling

Posture: **never brick input.**
- Kernel releases grabs on daemon death (inherent) + configurable **panic
  chord** (default `Ctrl+Alt+Backspace`) suspends all remapping + systemd
  `Restart=on-failure` restores last-good config.
- Config validation rejects any profile that would remap away all keys of the
  panic chord.
- Atomic config application; structured errors over IPC.
- Startup permission checks (input group, uinput access) produce actionable
  messages; the UI has a first-run setup check showing the exact udev
  rule/group commands needed.

## Testing

- **conduit-core:** exhaustive unit tests with a fake clock — every tap-hold
  timing edge case, buffering/replay, layers, held-key-across-profile-switch,
  as deterministic event-sequence tests ("press A at t=0, B at t=50, release
  A at t=100 → expect exactly [...]").
- **Daemon integration:** a test fixture creates a fake keyboard via uinput
  and emits real kernel events into a device the daemon grabs — full-loop
  verification without the developer's real keyboard.
- **UI:** component tests for config-editor logic; the key tester screen
  doubles as the manual E2E harness.

## Decisions log

| Decision | Choice | Why |
|---|---|---|
| Engine | Own thin Rust engine (evdev/uinput), not evsieve wrapper | Live per-app switching + latency fight evsieve's static pipeline; grab/forward core is small and well-trodden |
| Process model | User-level daemon + separate UI | Remapping must outlive UI; no root needed (udev rule + input/uinput groups, kanata model) |
| Wayland focus | Hyprland IPC only in v1 | No standard Wayland focus API; Hyprland's is clean; others later |
| Tap-hold rule | Permissive hold | QMK/kanata-proven; pure timeout punishes fast typists |
| Config | TOML file as canonical state | Power users can bypass the UI; UI and hand edits never fight |
| UI stack | Tauri | Design freedom for a genuinely nice UI; Rust IPC is native |
