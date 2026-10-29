# Investigation: Push-to-Talk key (F18) inconsistently delivered

**Status: ROOT CAUSE CONFIRMED 2026-10-28** — see "Confirmed root cause" below. It is a **KDE kglobalacceld bug**, not conduit, not the G502 wireless, not Discord. The original write-up below is kept for history; its TL;DR and ranked causes are superseded.

**Original status:** diagnosed, not yet fixed. Written up 2026-10-28 after a long live debugging session.
**Symptom (user-facing):** Discord push-to-talk is unreliable — mic opens then cuts out mid-hold, or doesn't trigger at all. Behaviour is *intermittent*, not deterministic. Reproduces across every Discord client (Flatpak, native tarball, Vesktop) and is independent of KDE shortcut config.

## Confirmed root cause (2026-10-28, live boundary trace)

**KDE's kglobalacceld deactivates a held portal global shortcut when ANY other key is released.**

Discord registers PTT via the XDG GlobalShortcuts portal — that's why its keybind shows the kglobalaccel-grabbed "Launch (9)"/UNK196, and why keycode 196 never reaches XWayland (kglobalaccel consumes it). kglobalacceld tracks the currently-held shortcut in `m_lastShortcut`, and `GlobalShortcutsRegistry::keyEvent()` (`src/globalshortcutsregistry.cpp`) runs this on **every non-modifier key release**:

```cpp
if (state == ShortcutKeyState::Released) {
    if (m_lastShortcut) {
        m_lastShortcut->context()->component()->emitGlobalShortcutEvent(*m_lastShortcut, state);
        m_lastShortcut = nullptr;
    }
}
```

It never compares the released key to the shortcut's key. Hold F18 (PTT active) and release W/A/S/D while moving in a game → kglobalacceld emits shortcut-released for the PTT shortcut → xdg-desktop-portal-kde sends `Deactivated` → Discord closes the mic while F18 is still physically held and still streaming through conduit. The "never fires at all" flavor is the same bug: press PTT while moving and the next WASD release deactivates it milliseconds after activation.

### Evidence (2026-10-28, Plasma 6.7.5)

- **CONDUIT_TRACE** (commit `7212d9f`): every F18 press/repeat/release was read from the G502 and emitted on the virtual keyboard; zero hotplug/disconnect events; zero synthesized releases all session. Wireless (old cause #1) and conduit (old causes #2/#3) exonerated.
- **dbus-monitor** on `org.freedesktop.portal.GlobalShortcuts`: `Activated` matches each conduit F18 Press to the millisecond. On bad holds, `Deactivated` arrives mid-hold:
  - hold 22:28:47.496→22:28:50.317 — Deactivated 22:28:49.420, **1 ms after a Wooting `a` release** (22:28:49.419)
  - hold 22:32:27.013→22:32:28.187 — Deactivated 22:32:27.446, **1 ms after a Wooting `w` release** (22:32:27.445)
  - control hold 22:33:34.984→22:33:37.077 with a `d` *press* mid-hold (no release): no early Deactivated. Other-key **presses** are fine; other-key **releases** kill it.
- **xinput test-xi2 (XWayland)**: 323 raw presses of other keys captured, keycode 196 never — confirms the portal path and rules out the X11 path.
- Bug present in installed `kglobalacceld-6.7.5` and still in kglobalacceld **master** as of 2026-10-28. No existing upstream report found.
- Side observation: the portal delivered every signal to **two** live Discord sessions (`discord_gs_9_1`, `discord_gs_123_1`, same shortcut `discord-push-to-talk-173`) — likely a stale duplicate registration; not the cause, but worth cleaning up by toggling the keybind in Discord.

### Fix

**Upstream (proper fix):** kglobalacceld must remember which key activated `m_lastShortcut` and emit released only for that key. Sketch — add `int m_lastShortcutKey = 0;`, set it next to `m_lastShortcut = shortcut;` in `processKey()` (`m_lastShortcutKey = keyQt & ~Qt::KeyboardModifierMask;`), then:

```cpp
if (state == ShortcutKeyState::Released) {
    if (m_lastShortcut && key == m_lastShortcutKey) {
        m_lastShortcut->context()->component()->emitGlobalShortcutEvent(*m_lastShortcut, state);
        m_lastShortcut = nullptr;
    }
}
```

File at https://bugs.kde.org against kglobalacceld with the evidence above (suggested title: *"GlobalShortcuts portal: held shortcut (push-to-talk) is Deactivated when any other key is released"*).

**Workarounds until the fix ships:**
- Build a patched kglobalacceld 6.7.5 and point the `plasma-kglobalaccel` user service at it (revertible drop-in; no rpm-ostree overlay needed).
- Avoid other-key releases during PTT (not practical in games).
- Discord's X11 keybind path (XWayland) only works if the kglobalaccel registration for Launch(9) is removed, and only while an XWayland window is focused.

**Conduit is not the fix locus** — nothing to change in conduit. The CONDUIT_TRACE instrumentation did its job; disable it after the dust settles (`systemctl --user revert`-style removal of the drop-in) since it logs key names to journald.

---

## Original analysis (superseded)

## TL;DR root cause

The PTT key is **not** a Discord/KDE/portal problem. It is the **physical key event (F18) arriving intermittently** at the OS. Conduit grabs the source device and re-emits F18 on its virtual keyboard; sometimes the key never comes out at all. Every downstream layer (KDE global-shortcut portal, Discord's keybind) was faithfully reacting to a signal that wasn't reliably there.

## Key facts established

1. **It's ONE key with three names.** The button sends Linux evdev `KEY_F18` (code 188). In X11/XWayland that becomes keycode **196**, whose keysym in the default map is **`XF86Launch9`** → KDE labels it **"Launch (9)"**, Discord labels it **"UNK196"**. F18 == 196 == Launch(9) == UNK196. (This caused hours of confusion: binding Discord to "F18" never matched because the actual keysym delivered is XF86Launch9; binding to "Launch (9)" did match.)

2. **Conduit does not remap F18.** `~/.config/conduit/conduit.toml` maps only f13/f14/f15/f20/f21. F18 is pure **passthrough**: conduit grabs the source device, reads the F18 EV_KEY event, and re-emits it unchanged on "Conduit Virtual Keyboard" (`/dev/input/event262`, vendor 1234 product 5678).

3. **The source is almost certainly the Logitech G502 X PLUS** (wireless). It's in both grab lists:
   ```toml
   grab_keyboards = [ "Logitech G502 X PLUS", "Wooting Wooting 80HE" ]
   grab_mice      = [ "046d:4099/Logitech G502 X PLUS" ]
   ```
   The G502 presents a single node `event7` with handlers `sysrq kbd leds mouse1` — i.e. it reports **both** keyboard keys and relative motion. A G502 onboard button is bound to F18.

4. **Direct evdev capture of a *hold* is inconsistent.** With conduit running, `sudo libinput debug-events` during a 5 s hold once showed exactly one `KEY_F18 (188) pressed` (good, sustained); a separate 12 s hold showed **zero** F18 events. Same physical action, different result → the key event itself is being lost before/at capture.

5. Confirmed NOT the cause: Discord client choice, KDE `kglobalshortcutsrc` duplicate/ghost entries (those F18 ghosts never fire — wrong keysym), the OpenH264 codec (separate, already fixed), release-delay setting, hardware-accel.

## Suspected root causes (ranked)

1. **G502 X PLUS wireless sleep/wake dropping events (most likely).** The G502 X PLUS aggressively power-saves. On wake it can disconnect/reconnect (hotplug) or drop the first event(s). If the PTT press lands during/just after a sleep→wake, the F18 press (or its release) is lost → mic never opens, or opens and the release/next-press cycle is corrupted → cutout. Intermittency matches idle→active transitions.
2. **Conduit grab gap on G502 reconnect.** If #1 triggers a `DeviceRemoved`/`DeviceAdded` cycle, there's a window where the device is ungrabbed/being re-grabbed. Events in that window are lost, and `engine.release_device()` fires on removal (see `runloop.rs` DeviceRemoved arm) — if a release is synthesized while the key is physically still held, PTT drops even though the user never let go.
3. **Reader poll/read race.** `devices::spawn_reader` uses `poll(fd, 50ms)` + `O_NONBLOCK` `fetch_events()`; comment acknowledges "rare race between poll & read" handled by WouldBlock. Unlikely to be primary but worth ruling out.

## How to reproduce / isolate (do this first)

Goal: determine whether F18 is lost **before** conduit (hardware/wireless) or **inside** conduit.

1. **Stop conduit** so nothing grabs the G502:
   `systemctl --user stop conduit.service`
2. Find the G502 raw node (currently `event7`) and watch ONLY it while holding the button for 10 s several times, including after letting the mouse sit idle 30–60 s first:
   `sudo evtest /dev/input/event7`  (or `sudo libinput debug-events --show-keycodes` filtered to F18)
3. Interpret:
   - **F18 press+release clean and sustained every time, even after idle** → conduit is dropping it; focus on reader/hotplug (causes #2/#3).
   - **F18 missing/stuttering after idle, or device shows disconnect/reconnect** → it's the G502 wireless (cause #1); conduit can only mitigate.
4. Cross-check with conduit running: `conduit-ui` has an event viewer (pre/post phase pushes — see `runloop.rs` `event_subs`), or subscribe over IPC, to see whether conduit *received* the F18 and whether it *emitted* it.

## Fix directions

- **If G502 wireless (cause #1):**
  - Disable the G502's power-saving/sleep (Logitech onboard profile via `libratbag`/`piper`, or keep it on the wired/charging cable so it never sleeps).
  - Consider moving the PTT bind to the **wired Wooting 80HE** or **wired G600** instead of the wireless G502 — a wired device won't sleep. (Note: Wooting analog keys with rapid-trigger can also double-fire; prefer a digital/standard key.)
  - In conduit: when a grabbed wireless device disconnects mid-hold, `release_device()` synthesizes releases for its held outputs. For a *passthrough* key that's fine, but consider NOT synthesizing a release for passthrough keys on transient unplug if the device returns within N ms (debounced re-grab) so a brief wireless blip doesn't cut PTT.

- **If conduit grab gap (cause #2):** add debounce to the hotplug remove→add cycle for a known device id so a wake doesn't fully tear down and rebuild the grab; hold the grab across a short reconnect window. Files: `crates/conduit-daemon/src/hotplug.rs`, `runloop.rs` (`DeviceRemoved`/`DeviceAdded` arms, `reconcile_grabs`).

- **If reader race (cause #3):** audit `crates/conduit-daemon/src/devices.rs::spawn_reader` poll/fetch loop for any path that could silently drop a key event; add a debug counter of EV_KEY in vs Msg::Input sent.

## Relevant code

- `crates/conduit-daemon/src/devices.rs` — `spawn_reader` (reader thread: grab, poll, fetch_events, EV_KEY→Msg::Input), `should_grab`, `probe`.
- `crates/conduit-daemon/src/runloop.rs` — engine thread; `DeviceRemoved`/`DeviceAdded`/`reconcile_grabs`; `emit_all`; pre/post event subscriber pushes (useful for a built-in event trace).
- `crates/conduit-daemon/src/hotplug.rs` — hotplug add/remove + EACCES settle/retry.
- `crates/conduit-core/src/engine.rs` — `release_device()` (synthesizes releases for a departed device's held outputs — review for PTT-cutting-on-blip), passthrough path in `process()`.
- `crates/conduit-daemon/src/output.rs` — virtual keyboard (no EV_REP; compositor handles repeat). Passthrough emit path.
- `~/.config/conduit/conduit.toml` — grab lists + profiles (no F18 remap; F18 is passthrough).

## Suggested first commit

Add an opt-in debug trace: per-grabbed-device counters of EV_KEY read vs `Msg::Input` sent, and log every `DeviceRemoved`/`DeviceAdded` with timestamps + device id. Run it, reproduce the cutout, and the logs will immediately show whether F18 was read-but-not-emitted (conduit bug) or never-read (wireless). That single data point decides between cause #1 and #2/#3.

**Status: implemented (2026-10-28).** `crates/conduit-daemon/src/trace.rs`, wired into `devices.rs::spawn_reader`, `runloop.rs` (`DeviceAdded`/`DeviceRemoved` incl. which releases `release_device` synthesized, and every emitted output event), and `hotplug.rs` (raw udev add/remove, which predates `Msg::DeviceAdded` by the 100 ms settle sleep).

### Using the trace

Enable by setting `CONDUIT_TRACE=1` in the daemon's environment and restarting it:

```sh
systemctl --user edit conduit.service   # add under [Service]: Environment=CONDUIT_TRACE=1
systemctl --user restart conduit.service
```

Then reproduce (hold PTT after letting the G502 idle 30–60 s) and read the journal:

```sh
journalctl --user -u conduit.service -f | grep -E 'trace.*(f18|code=188|udev|hotplug|reader exit)'
```

Lines are stamped `t=<monotonic µs>` on the same time base as event `time_us`. What to look for during a bad hold:

- **No `read: … code=188` line** → the kernel never delivered F18 → wireless/hardware (cause #1). A nearby `udev: remove`/`udev: add` pair confirms a sleep-wake reconnect blip.
- **`read` line but no matching `emit: code=188`** → conduit dropped it between reader and output (causes #2/#3).
- **`hotplug: removed … synthesized_releases=["f18"]` mid-hold** → the grab-gap release synthesis is cutting PTT (cause #2's second half).
- **`reader exit` lines** show per-device totals `ev_key_read` vs `inputs_sent`; a gap (beyond unknown EV_KEY values, which are counted as read but not sent) means the reader dropped events.

Disable again by removing the drop-in (`systemctl --user revert conduit.service`) — off is the default and the trace has no cost when disabled.
