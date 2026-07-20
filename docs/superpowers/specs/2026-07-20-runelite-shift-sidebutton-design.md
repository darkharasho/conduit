# RuneLite Shift Side Button — Design

**Date:** 2026-07-20
**Status:** Approved (Option B)

## Goal

The G502 X side button (currently onboard-mapped to KEY_V via ratbagctl) should:

- type **v** everywhere, as it does today
- hold **Shift** while RuneLite is focused (press = Shift down, release = Shift up, so shift-click works)

## Decision

**Option B — neutral onboard code, software translation.** The onboard mapping
becomes KEY_F15 (the F13–F24 stand-in convention the onboard wizard already
uses). The conduit daemon translates F15 per focused app. This makes the button
a first-class identity conduit recognizes (mouse-art marker, per-app mapping in
the UI) at the cost that the button is inert when the daemon is not running.

Option A (keep onboard KEY_V, device-scoped `v → shift` override in the
RuneLite profile) was considered and rejected: it works, and degrades to "still
types v" without the daemon, but conduit can never recognize the button as a
button — the physical identity is erased at the firmware level and the rule
reads as a remap of the letter v.

## Architecture

All existing machinery; **no repo code changes**:

- **evdev grab + uinput rewrite**: `conduit-daemon` (devices.rs, output.rs,
  conduit-core engine)
- **Focus switching**: KWin scripting D-Bus backend → `Msg::Focus` →
  `Engine::set_focus` picks the matching `auto_switch` profile
- **Onboard write**: ratbagctl macro `+KEY_F15 -KEY_F15`, same form as the
  onboard fix wizard

## Work items

1. **Install the daemon persistently.** Release build of `conduit-daemon` →
   `~/.local/bin/conduit-daemon` (path `packaging/conduit.service` expects).
   Install `packaging/99-conduit.rules` udev rule (sudo; user must be in
   `input` group). `systemctl --user enable --now conduit`.
2. **Onboard rewrite KEY_V → KEY_F15.** Restore ratbagd visibility of the
   G502 X (ratbagctl currently lists no devices — re-apply the
   `packaging/libratbag` data-dir setup / start ratbagd as needed). Locate the
   button by its current KEY_V macro; set it to `+KEY_F15 -KEY_F15`.
3. **Config** (`~/.config/conduit/conduit.toml`):

   ```toml
   [profile.default.keys]
   f15 = "v"

   [profile.runelite]
   inherit = "default"

   [profile.runelite.match]
   class = "<real RuneLite client class, captured live>"

   [profile.runelite.keys]
   f15 = "leftshift"
   ```

   The stored class `net-runelite-launcher-Launcher` is the launcher's, not
   the game client's; capture the real one via the daemon's ListWindows with
   RuneLite open. No device scoping needed — nothing else emits F15.

## Error handling

- Daemon stopped → button inert (accepted trade-off; service uses
  `Restart=on-failure`).
- Wrong/unmatched RuneLite class → default profile applies → button types v in
  RuneLite. Never a stuck Shift: worst case is the harmless default.
- Config parse failure → daemon keeps last good config (existing behavior).

## Verification

- Button types v in a desktop editor (F15 → v translation live).
- With RuneLite focused: button holds Shift (user confirms in-game shift-click).
- Alt-tab away: reverts to v.
- `systemctl --user status conduit` healthy after reboot.
