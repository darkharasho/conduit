# conduit

A low-latency, profile-aware keyboard remapper daemon for Linux. Conduit grabs
input devices at the evdev level, translates key events through compiled
remapping profiles (including tap-vs-hold, layers, and per-application
switching), and re-emits them through a uinput virtual device — all in user
space with no kernel patch required.

## Features (v1 scope)

- **Tap-vs-hold** remapping per key (e.g. CapsLock → tap Escape, hold Ctrl)
- **Named layers** with toggle and while-held activation
- **Per-application profiles** matched by window class, process name, or title
  regex (Hyprland, KDE Plasma Wayland, and X11 supported)
- **Mouse remapping** — buttons (`btn_left`…`btn_task`, `mouse4`/`mouse5`) and
  scroll wheel (`wheelup`, `wheeldown`, `wheelleft`, `wheelright`) map like any
  key; pointer motion passes through with zero added latency
- **Hardware classification** — devices are classified by capabilities
  (keyboard / mouse / touchpad / gamepad / media), so a gaming mouse's hidden
  keyboard node is grabbable and your speakers' volume keys are not
- **Panic chord** — a configurable key combo that instantly suspends remapping
  to recover from a misconfigured keymap
- **Hot-reload** — hand-edit `conduit.toml` and changes take effect within
  ~500 ms; invalid TOML is rejected without dropping the live config
- **IPC socket** — a newline-delimited JSON Unix socket for programmatic
  control (used by the companion UI)
- **Hotplug** — new keyboards and mice are grabbed automatically as they appear

## Device selectors

Entries in `devices.grab_keyboards` / `devices.grab_mice` accept three forms:

```toml
[devices]
grab_all_keyboards = true
grab_all_mice = false          # never includes touchpads
grab_mice = [
  "Logitech Gaming Mouse G600",        # exact device name
  "046d:c24a",                         # vendor:product (hex)
  "046d:c24a/Logitech Gaming Mouse G600 Keyboard",  # vendor:product/name
]
```

The `vendor:product/name` form disambiguates receivers and gaming devices that
expose several event nodes under one vendor/product pair.

## Focus tracking (per-app profiles)

The daemon picks a focus backend automatically, in priority order: Hyprland
(IPC socket) → KDE Plasma Wayland (a KWin script injected over D-Bus reports
window activations) → X11 (`_NET_ACTIVE_WINDOW`). On KDE the script is
re-injected automatically if KWin restarts; no configuration is needed.

## Quickstart (dev)

One command builds the daemon, starts it in the background, and opens the UI
(Ctrl-C stops both; an already-running daemon is detected and reused):

```bash
cd ui && npm install && npm run dev
```

Nothing is remapped until you opt in: enable a device on the **Devices** screen
(or set `grab_all_keyboards = true` in `~/.config/conduit/conduit.toml`), then
add mappings on the **Mappings** screen. `Ctrl+Alt+Backspace` suspends all
remapping at any time.

## Install

### 1. udev rule (one-time, requires sudo)

```bash
sudo cp packaging/99-conduit.rules /etc/udev/rules.d/
sudo udevadm control --reload && sudo udevadm trigger
```

### 2. Add user to the `input` group (one-time, requires re-login)

```bash
sudo usermod -aG input $USER   # then re-login
```

### 3. Build and install the daemon binary

```bash
cargo build --release -p conduit-daemon && install -Dm755 target/release/conduit-daemon ~/.local/bin/
```

> **Note:** Building the full workspace (`cargo build --release`) requires GTK
> and webkit2gtk development headers (needed by the Tauri UI). Build only the
> daemon with `-p conduit-daemon` if you don't need the UI.

### 4. Install and enable the systemd user unit

```bash
mkdir -p ~/.config/systemd/user/
cp packaging/conduit.service ~/.config/systemd/user/
systemctl --user enable --now conduit.service
```

## Startup permission check

Run `conduit-daemon --check` to verify that all permissions are in place before
starting the daemon. The UI uses this for first-run setup guidance.

```bash
conduit-daemon --check
# {"uinput":true,"input_group":true,"config_ok":true}
```

Fields:
- `uinput` — whether `/dev/uinput` is writable (requires udev rule above)
- `input_group` — whether the current user is in the `input` group
- `config_ok` — whether the current config file compiles without error

Note: on systemd/logind desktops, `input_group` may report `false` even though the daemon works — logind grants device access to your active session automatically. Adding yourself to the `input` group is only needed for headless or non-seat sessions.

## Build requirements

- Rust 1.75+ (2021 edition)
- `libudev-devel` (the `evdev` crate uses pure ioctl and does **not** need
  `libevdev-devel`)
- Linux kernel with `uinput` module (`modprobe uinput` if not auto-loaded)
- For the UI only: `webkit2gtk4.1-devel` (or equivalent) for Tauri

**Fedora / RPM-family systems:** the pkg-config files for libudev live in
`/usr/lib64/pkgconfig`, which is not always on the default search path. Set:

```bash
export PKG_CONFIG_PATH=/usr/lib64/pkgconfig
cargo build --release
```

## Config

The config file lives at `$XDG_CONFIG_HOME/conduit/conduit.toml`
(default: `~/.config/conduit/conduit.toml`). A commented default is created
automatically on first run.

```toml
[settings]
tap_hold_timeout = 200        # milliseconds
panic_chord = ["leftctrl", "leftalt", "backspace"]

[devices]
grab_all_keyboards = true     # or list specific devices below
# grab_keyboards = ["AT Translated Set 2 keyboard"]
# grab_mice = []

[profile.default.keys]
capslock = { tap = "esc", hold = "leftctrl" }
a = "b"

[profile.gaming]
match = { class = "steam_app_123" }

[profile.gaming.keys]
capslock = "passthrough"
```

**Profile matching notes:**

- `class` and `process` are **exact-match** strings (no glob expansion).
  Use the exact window class or process name as reported by your compositor.
- `title` accepts a **regular expression** (e.g. `title = ".*vim.*"`).

Edit the file while the daemon is running — changes are picked up within
~500 ms. Invalid TOML is logged and the previous config remains active.

## UI (Tauri app)

The companion UI provides a graphical interface to view device status, edit
mappings, and test key codes.  It connects to the running daemon automatically
via the IPC socket.

```bash
cd ui && npm install && npm run tauri dev
```

Requires `webkit2gtk` development headers and a running `conduit-daemon`
instance.
