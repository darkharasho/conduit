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
  regex (Hyprland and X11 supported)
- **Panic chord** — a configurable key combo that instantly suspends remapping
  to recover from a misconfigured keymap
- **Hot-reload** — hand-edit `conduit.toml` and changes take effect within
  ~500 ms; invalid TOML is rejected without dropping the live config
- **IPC socket** — a newline-delimited JSON Unix socket for programmatic
  control (used by the companion UI)
- **Hotplug** — new keyboards and mice are grabbed automatically as they appear

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
cargo build --release && install -Dm755 target/release/conduit-daemon ~/.local/bin/
```

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
- `libudev-devel` and `libevdev-devel` (or the distro equivalents)
- Linux kernel with `uinput` module (`modprobe uinput` if not auto-loaded)

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
match = { class = "steam_app_*" }

[profile.gaming.keys]
capslock = "passthrough"
```

Edit the file while the daemon is running — changes are picked up within
~500 ms. Invalid TOML is logged and the previous config remains active.
