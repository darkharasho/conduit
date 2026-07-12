# Final Review Fixes — Conduit v1

Date: 2026-07-12
Branch: feature/conduit-v1

## C1 — Production Daemon Exits Immediately

**Root cause:** `main.rs` called `handle.shutdown()` which sends `Msg::Shutdown`
to the runloop, causing the daemon to exit cleanly (exit 0) ~3 s after start.
`systemd Restart=on-failure` does not restart on exit 0.

**Fix:**
- Added `pub fn wait(self)` to `DaemonHandle` in `lib.rs`. Joins the run-loop
  thread WITHOUT sending Shutdown. The daemon stays alive until an external
  signal or all channel senders are dropped.
- Changed `main.rs` line 206 from `handle.shutdown()` to `handle.wait()`.
- `shutdown()` is kept unchanged for use in integration tests.

**Evidence:** Empirical daemon-stays-alive test:
```
Starting daemon... (PID 1448911)
[11s passes, no events grabbed, grab_all_keyboards = false]
PASS: daemon still alive after 11 seconds (PID 1448911)
```

## C2 — Shutdown Deadlock With Grabbed Readers

**Root cause:** The grabbed reader path in `devices.rs` used blocking
`fetch_events()`. `GrabHandle::drop` sets the stop flag then joins the thread,
but the thread was blocked indefinitely inside `fetch_events()` waiting for the
next kernel event. This caused drop to deadlock when no input was happening
(e.g. during test shutdown).

**Fix:** Both grab paths now set `O_NONBLOCK` on the device fd unconditionally.
For grabbed devices, the reader loop uses `libc::poll()` with a 50 ms timeout
before each `fetch_events()` call:
- If `poll()` returns with no POLLIN (timeout or EINTR): loop back and recheck
  the stop flag. At most 50 ms latency to honor stop.
- If `poll()` returns POLLIN: call `fetch_events()`. WouldBlock on the subsequent
  read (rare race) is handled with a continue.
- For ungrabbed (test) devices: same O_NONBLOCK; WouldBlock uses 2 ms sleep (same
  as before). The poll path is skipped (`if do_grab`).

Latency tradeoff: zero added latency for arriving events (poll returns
immediately when the fd is readable). Stop flag honored within ~50 ms.

**Evidence:** Integration test `daemon_starts_and_stops_cleanly` and
`full_loop_key_remap_and_ipc` both call `handle.shutdown()` which joins the
run-loop, which drops GrabHandles. All 3 integration tests passed in 6.08 s
total, with no joins hanging.

## C3 — ListDevices Only Returns Grabbed Devices

**Root cause:** `ipc.rs` dispatched `Request::ListDevices` via
`query(tx, QueryKind::Devices)`, which went to the runloop. The runloop's
`QueryKind::Devices` arm answered from `grabbed_devices` only — so the UI
Devices screen showed nothing until at least one device was grabbed.

**Fix:** Added `list_devices_response()` helper in `ipc.rs` that:
1. Calls `devices::discover()` directly (off the hot path) to enumerate ALL
   input devices.
2. Gets the current grabbed set via a `QueryKind::GetStatus` query (reuses
   the existing Status path).
3. Sets `DeviceInfo.grabbed` by cross-referencing discover() results with the
   grabbed paths from Status.

The `QueryKind::Devices` arm in `runloop.rs` is left in place (still used
internally; removing it would risk breaking future uses), but the IPC handler
no longer calls it for `ListDevices`.

**Evidence:** `ipc_list_devices_returns_devices` unit test passes. In the test
fixture, `readers` is an empty HashMap (no grabs), yet the response is
`Response::Devices { .. }` containing the discovered devices from the test
machine.

## C4 — README Corrections

Four fixes applied to `README.md`:

**(a) Glob matcher lie:**
Changed `match = { class = "steam_app_*" }` to `match = { class = "steam_app_123" }`.
Added note: `class`/`process` are exact-match; `title` accepts a regex.

**(b) Build command:**
Changed `cargo build --release` to `cargo build --release -p conduit-daemon`.
Added note that full workspace build requires GTK/webkit2gtk headers.

**(c) Build deps:**
Removed `libevdev-devel` from requirements (the `evdev` crate uses pure ioctl,
no libevdev linking needed). Kept `libudev-devel` (real dependency).
Added `webkit2gtk4.1-devel` as UI-only requirement.

**(d) UI section:**
Added "UI (Tauri app)" section at the end with `cd ui && npm install && npm run tauri dev`.

## Verification Gates

### Gate 1: `cargo test --workspace`
```
test result: ok. 36 passed; 0 failed; 0 ignored  (conduit-core)
test result: ok. 50 passed; 0 failed; 3 ignored  (conduit-daemon lib)
test result: ok. 0 passed; 0 failed; 3 ignored   (conduit-daemon integration — skipped without --ignored)
test result: ok. 3 passed; 0 failed; 0 ignored   (conduit-proto)
```
All green.

### Gate 2: `cargo test -p conduit-daemon --test integration -- --ignored`
```
running 3 tests
test daemon_starts_and_stops_cleanly ... ok
test engine_via_channel_smoke ... ok
test full_loop_key_remap_and_ipc ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 6.08s
EXIT CODE: 0
```
3 passed, process exited in 6.08 s (< 120 s limit).

### Gate 3: C1 Empirical Daemon-Alive Check
```
Daemon PID: 1448911
[11 seconds elapsed, no grab, CONDUIT_SOCKET overridden]
PASS: daemon still alive after 11 seconds (PID 1448911)
```

### Gate 4: vitest + cargo build warnings
```
Tests  72 passed (72)  [vitest]
cargo build --workspace warnings: 0
```
