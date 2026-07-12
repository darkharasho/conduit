# KDE Wayland focus, mouse remapping, hardware detection, profile↔app linking

**Date:** 2026-07-12
**Status:** Approved (user delegated design decisions; environment probed live)

## Context

Conduit's input path (evdev grab → engine → uinput) already works on any display
server. What does *not* work on the user's machine (KDE Plasma 6.7.1, Wayland)
is everything that depends on knowing the focused window: per-app profiles,
the window picker, and `ListWindows`. Only Hyprland and X11 focus backends
exist today.

Live probing established:

- KWin 6.7 does **not** expose `org_kde_plasma_window_management`,
  `zwlr_foreign_toplevel_management_v1`, or `ext_foreign_toplevel_list_v1` to
  regular Wayland clients — a protocol-based backend is impossible.
- The KWin **Scripting D-Bus API** (`org.kde.KWin` → `/Scripting`) is available
  and works end-to-end (verified via `kdotool getactivewindow`). This is the
  same mechanism xremap and kdotool use.
- The machine's hardware is full of composite devices that the current
  classifier mishandles: a Wooting 80HE keyboard exposing a *Mouse* node,
  Logitech G600 / E9PRO mice exposing *Keyboard* nodes, a Logitech USB
  Receiver exposing five nodes, and Audioengine speakers exposing volume-key
  "keyboards".

Scope per user: KDE Wayland is the target environment. GNOME and wlroots
backends are non-goals (the backend trait keeps them possible later).

## 1. KDE Wayland focus backend

### Approach

**Chosen: KWin script + D-Bus callback (zbus).** The daemon claims a session
D-Bus name and injects a small JavaScript file into KWin via the Scripting API;
the script calls back over D-Bus on every window activation.

Rejected alternatives:

- *plasma-window-management Wayland protocol* — not exposed to regular clients
  on KWin 6.7 (verified above).
- *Polling `kdotool`/`qdbus` subprocesses* — process-spawn latency per poll,
  no push events, external binary dependency.

### Components

**`focus/kde.rs`** implementing the existing `FocusBackend` trait:

- **D-Bus service** (new dependency: `zbus`, blocking API to match the
  thread-per-backend model): claims `org.conduit.Conduit`, exports
  `/org/conduit/Focus`, interface `org.conduit.Focus`:
  - `NotifyActiveWindow(caption: s, resource_class: s, pid: i)` → translated
    to `Msg::Focus(FocusInfo)`. `process` is read from `/proc/<pid>/comm`
    (same as the Hyprland backend).
  - `NotifyWindowList(json: s)` → parsed for `list_windows()` (below).
- **Persistent KWin script** (source embedded in the binary, written to
  `$XDG_RUNTIME_DIR/conduit/kwin-focus.js` at startup):
  - Plasma 6 API (`workspace.windowActivated`, `workspace.activeWindow`) with
    a Plasma 5 fallback shim (`clientActivated`/`activeClient`).
  - Sends the initial active window on load.
  - Tracks `captionChanged` on the currently active window (connect on
    activate, disconnect on deactivate) so `title` regex matchers stay live —
    parity with Hyprland, which re-emits on title change.
- **Script lifecycle** via `org.kde.KWin /Scripting org.kde.kwin.Scripting`:
  `unloadScript("conduit-focus")` (idempotent cleanup of a stale copy) →
  `loadScript(path, "conduit-focus")` → `run()` on the returned
  `/Scripting/Script<id>` object.
- **KWin restart resilience**: subscribe to `NameOwnerChanged` for
  `org.kde.KWin`; when a new owner appears, reload the script. Standard
  1 s → 30 s doubling backoff (reuse `next_backoff`) on D-Bus errors.

**`list_windows()` for KDE**: load a **one-shot script** (`conduit-winlist`)
that serializes `workspace.windowList()` (caption, resourceClass, pid) to JSON
and calls `NotifyWindowList`, then is unloaded. The caller waits on a channel
with a 2 s timeout. Guarded by a mutex (UI-triggered, not a hot path).

### Detection order (`focus::detect()`)

1. Hyprland (`HYPRLAND_INSTANCE_SIGNATURE`)
2. **KDE** — `XDG_SESSION_TYPE == "wayland"` and `org.kde.KWin` reachable on
   the session bus
3. X11 (`DISPLAY`)
4. None (warning, default profile only)

KDE-on-X11 keeps using the X11 backend (already works, no KWin dependency).

## 2. Mouse support

### Wheel remapping

Scroll wheel ticks become mappable inputs via **pseudo-key codes** in the
unassigned evdev range (all < `KEY_TABLE_SIZE`):

| name | code |
|---|---|
| `wheelup` | 0x2F8 |
| `wheeldown` | 0x2F9 |
| `wheelleft` | 0x2FA |
| `wheelright` | 0x2FB |

- **Reader thread** (grabbed mice): `REL_WHEEL`/`REL_HWHEEL` events are
  translated to a Press+Release pair of the pseudo-key per tick (value ±N → N
  pairs) and sent through the engine like any key. `REL_WHEEL_HI_RES`/
  `REL_HWHEEL_HI_RES` are dropped (they would double-scroll; the compositor's
  libinput re-synthesizes hi-res from low-res). `REL_X`/`REL_Y` motion keeps
  the existing direct-to-uinput path — no added latency where it matters.
- **VirtualOutput::emit**: pseudo wheel codes are translated back to
  `REL_WHEEL`/`REL_HWHEEL` ±1 on the virtual mouse (on Press; Release is
  swallowed). Real keys mapped from wheel go to the virtual keyboard as usual.
  Unmapped wheel input passes through the engine untouched (pseudo code in →
  pseudo code out → REL event), so scrolling works with zero config.
- Engine needs no changes: pseudo-keys are ordinary `Key(u16)` values.

### Config & naming

- New setting `devices.grab_all_mice: bool` (default `false`), symmetric with
  `grab_all_keyboards`. Only devices classified `Mouse` qualify — **never
  touchpads** (grabbing a touchpad kills gestures; explicit `grab_mice` entry
  required to override).
- Key-name table gains `btn_forward` (0x115), `btn_back` (0x116), `btn_task`
  (0x117) and wheel pseudo-keys above.

## 3. Hardware detection

### Classification

`devices::probe()` is split into a **pure `classify(caps) -> DeviceClass`**
function (unit-testable on synthetic capability sets) over a `Caps` struct
holding: supported keys, relative axes, absolute axes, and input properties.

```rust
enum DeviceClass { Keyboard, Mouse, Touchpad, Gamepad, MediaKeys, Other }
```

Rules (first match wins):

- **Touchpad**: `ABS_X`+`ABS_Y` with `BTN_TOUCH` or `INPUT_PROP_POINTER`
- **Gamepad**: `BTN_SOUTH` (gamepad) or `BTN_JOYSTICK` range
- **Mouse**: `REL_X`+`REL_Y`+`BTN_LEFT`
- **Keyboard**: ≥ 20 typing keys (letters/digits/enter/space region) — filters
  out Consumer/System Control nodes that today count as "keyboards"
- **MediaKeys**: any `EV_KEY` (volume/media/power) below the typing threshold
- **Other**: everything else

`is_keyboard`/`is_mouse` booleans remain (grab eligibility) but derive from
class: `is_keyboard = class == Keyboard`, `is_mouse = class == Mouse`.
This fixes: Audioengine speakers and G600 "Consumer Control" nodes no longer
auto-grabbed by `grab_all_keyboards`; Wooting's mouse node is a real grabbable
mouse; G600's keyboard node stays grabbable (it genuinely emits key codes).

### Device identity

Grab lists accept three selector forms (matched in this order):

1. `"Logitech Gaming Mouse G600"` — exact name (existing behavior, unchanged)
2. `"046d:c24a"` — vendor:product hex
3. `"046d:c24a/Logitech Gaming Mouse G600 Keyboard"` — vendor:product/name,
   for receivers exposing multiple same-VID/PID nodes with different names

`DeviceInfo` (proto) gains `id` (canonical `vid:pid/name` selector), `class`
(string), and `phys`. The UI writes the canonical `id` form for new grabs;
plain names in existing configs keep working.

## 4. Profile ↔ application linking

The config layer (`[profile.X.match]` with process/class/title) and the UI's
new-profile window picker already exist. Missing pieces:

- **Daemon**: `ListWindows` returns data on KDE (Feature 1's one-shot script).
- **UI — match editor**: the Mappings inspector gains a per-profile "Match"
  section showing class/process/title fields, editable inline, with a
  "pick from open windows" button reusing the existing window-picker modal.
  Writes through the existing `ConfigModel` → TOML → `SetConfig` path.
- **UI — Devices screen**: shows `class` badges (Keyboard / Mouse / Touchpad /
  Gamepad / Media / Other) from the extended `DeviceInfo`, a mouse grab
  toggle backed by `grab_all_mice`/`grab_mice`, and the canonical device `id`.

## Error handling

- KWin D-Bus unreachable / script load fails → log warning, retry with
  backoff; daemon runs with default profile only (same degradation as today
  with no display).
- KWin restarts → `NameOwnerChanged` triggers script reload.
- `ListWindows` timeout (2 s) → empty list + IPC error message, UI shows
  existing empty state.
- Malformed `NotifyWindowList` JSON → logged, empty list.
- Unknown selector syntax in grab lists → treated as a plain name (never a
  hard config error; preserves back-compat).

## Testing

- **conduit-core**: key-name round-trips for new names; wheel pseudo-code
  constants; `grab_all_mice` parsing; selector parse/match table tests.
- **conduit-daemon**: `classify()` against synthetic caps modeled on the real
  machine inventory (Wooting 4-node, G600 3-node, receiver 5-node, speakers);
  wheel tick → pseudo-event translation (pure fn); KWin script source sanity;
  `NotifyWindowList` JSON parsing; `detect()` priority with env fixtures;
  `should_grab` with selectors and touchpad exclusion.
- **Ignored live test** (`live_kde_verification`, like the Hyprland one): load
  the script into the real KWin, assert an active-window callback and a window
  list arrive. Run on this machine as part of verification.
- **UI**: vitest (maxWorkers ≤ 2) for the match editor and Devices badges,
  following the existing mock pattern.

## Non-goals

- GNOME and wlroots focus backends (trait keeps the door open).
- Scroll gestures, hi-res wheel remapping granularity, pointer acceleration.
- Mouse motion remapping (axis inversion etc.).
- Per-device profiles (profiles remain focus-driven).
