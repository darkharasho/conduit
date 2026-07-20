# RuneLite Shift Side Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** G502 X side button types v everywhere but holds Shift while RuneLite is focused, via onboard KEY_F15 + conduit per-app translation.

**Architecture:** Machine setup only — no repo code changes. Onboard firmware emits the neutral code F15; the conduit daemon (installed as a systemd user service) grabs the mouse's keyboard interface and translates F15 → v in the default profile, F15 → leftshift in the RuneLite profile, switching on KWin focus events.

**Tech Stack:** cargo (Rust release build), systemd user units, ratbagctl/ratbagd, newline-delimited JSON over `$XDG_RUNTIME_DIR/conduit.sock`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-20-runelite-shift-sidebutton-design.md`
- Build with `PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig` (linuxbrew pkg-config shadows system).
- No sudo available this session; verified unnecessary: `/dev/uinput` already writable, ratbagd already active with `LIBRATBAG_DATA_DIR=/etc/libratbag` (patched `logitech-g502-x-plus.device` present).
- G502 X is currently **disconnected** (absent from lsusb and /proc/bus/input/devices). Tasks 1–3 proceed without it; Task 4 blocks until it reappears.
- Config file: `~/.config/conduit/conduit.toml`. Preserve existing `[settings]` and `[devices]` sections verbatim.

---

### Task 1: Build and install conduit-daemon

**Files:**
- Create: `~/.local/bin/conduit-daemon` (installed binary)

**Interfaces:**
- Produces: release binary at the exact path `packaging/conduit.service` expects (`%h/.local/bin/conduit-daemon`).

- [ ] **Step 1: Release build**

```bash
cd /var/home/mstephens/Documents/GitHub/conduit
PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig cargo build --release -p conduit-daemon
```

Expected: `Finished 'release' profile` (warnings OK, no errors).

- [ ] **Step 2: Install**

```bash
mkdir -p ~/.local/bin
install -m755 target/release/conduit-daemon ~/.local/bin/conduit-daemon
~/.local/bin/conduit-daemon --help || true
```

Expected: binary exists; help/usage or immediate startup attempt (no linker errors).

### Task 2: Install and start the user service

**Files:**
- Create: `~/.config/systemd/user/conduit.service` (copy of `packaging/conduit.service`)

**Interfaces:**
- Consumes: `~/.local/bin/conduit-daemon` from Task 1.
- Produces: running daemon with socket at `$XDG_RUNTIME_DIR/conduit.sock`; Task 3/5 talk to it.

- [ ] **Step 1: Install unit**

```bash
mkdir -p ~/.config/systemd/user
cp packaging/conduit.service ~/.config/systemd/user/conduit.service
systemctl --user daemon-reload
```

- [ ] **Step 2: Enable + start**

```bash
systemctl --user enable --now conduit.service
sleep 1
systemctl --user status conduit.service --no-pager | head -8
```

Expected: `Active: active (running)`.

- [ ] **Step 3: Socket sanity check**

```bash
ls -l "$XDG_RUNTIME_DIR/conduit.sock"
python3 - <<'EOF'
import socket, os, json
s = socket.socket(socket.AF_UNIX); s.connect(os.environ["XDG_RUNTIME_DIR"]+"/conduit.sock")
s.sendall(b'{"type":"GetConfig"}\n')  # adjust tag shape to conduit-proto serde if needed
print(s.recv(65536).decode()[:200])
EOF
```

Expected: socket exists; JSON response (adjust request framing to match `conduit-proto` if the tag differs — check `crates/conduit-proto/src/lib.rs` serde attributes before assuming).

### Task 3: Update conduit.toml

**Files:**
- Modify: `~/.config/conduit/conduit.toml`

**Interfaces:**
- Consumes: running daemon (Task 2) picks up config (SetConfig or file watch/reload — verify which; restart service as fallback).
- Produces: profiles `default` (f15→v) and `runelite` (f15→leftshift) that Task 4's onboard F15 will drive.

- [ ] **Step 1: Write new config** (preserving `[settings]`/`[devices]` verbatim):

```toml
[settings]

[devices]
grab_keyboards = [ "Logitech G502 X PLUS", "Wooting Wooting 80HE" ]
grab_mice = [ "046d:4099/Logitech G502 X PLUS" ]

[profile.default.keys]
f15 = "v"

[profile.runelite]
inherit = "default"

[profile.runelite.match]
class = "net-runelite-launcher-Launcher"

[profile.runelite.keys]
f15 = "leftshift"
```

(Class is provisional; corrected in Task 5.)

- [ ] **Step 2: Reload daemon and confirm config accepted**

```bash
systemctl --user restart conduit.service && sleep 1
systemctl --user status conduit.service --no-pager | head -6
journalctl --user -u conduit.service -n 20 --no-pager
```

Expected: active (running), no config parse errors in the journal.

### Task 4: Onboard rewrite KEY_V → KEY_F15 (blocked: mouse must be connected)

**Files:** none (mouse firmware via ratbagctl)

**Interfaces:**
- Consumes: ratbagd (active, patched data dir already in place).
- Produces: side button emits F15; the daemon's Task 3 config translates it.

- [ ] **Step 1: Wait for device**

```bash
timeout 10 ratbagctl list
```

Expected: a line naming the G502 X. If `No devices available.`, the mouse is still offline — pause here and tell the user to power on / plug in the mouse (receiver absent from lsusb).

- [ ] **Step 2: Find the KEY_V button**

```bash
DEV=$(ratbagctl list | head -1 | cut -d: -f1)
ratbagctl "$DEV" profile 0 | grep -n "KEY_V"
```

Expected: exactly one button line containing KEY_V; note its button index N.

- [ ] **Step 3: Rewrite to F15**

```bash
ratbagctl "$DEV" profile 0 button N action set macro +KEY_F15 -KEY_F15
ratbagctl "$DEV" profile 0 button N action get
```

Expected: action get reports the F15 macro.

### Task 5: Capture RuneLite class and verify end-to-end (user participation)

**Files:**
- Modify: `~/.config/conduit/conduit.toml` (real class)

**Interfaces:**
- Consumes: daemon `ListWindows` request (same socket framing as Task 2 Step 3).

- [ ] **Step 1: With RuneLite open, list windows and find the game client's class**

```bash
python3 - <<'EOF'
import socket, os
s = socket.socket(socket.AF_UNIX); s.connect(os.environ["XDG_RUNTIME_DIR"]+"/conduit.sock")
s.sendall(b'{"type":"ListWindows"}\n')
print(s.recv(262144).decode())
EOF
```

Expected: JSON window list; pick the entry whose title is the RuneLite game window and record its `class`.

- [ ] **Step 2: Update `class = "..."` in the runelite profile, restart service** (same commands as Task 3 Step 2).

- [ ] **Step 3: Verification checklist (user at keyboard/mouse)**

- Side button in a text editor types `v`.
- Side button held in focused RuneLite holds Shift (shift-click works).
- Alt-tab away → types `v` again.
- `systemctl --user is-enabled conduit` → `enabled` (reboot persistence).
- Wooting `v` key unaffected everywhere.
