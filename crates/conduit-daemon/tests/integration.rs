//! Integration tests for conduit-daemon.
//!
//! # Strategy
//!
//! All tests tagged `#[ignore]` require `/dev/uinput` write access and
//! `/dev/input` read access (i.e. membership in the `input` group).
//!
//! ## Full-loop test (`full_loop_key_remap_and_ipc`)
//!
//! Creates a real uinput keyboard, starts the daemon, waits for the daemon's
//! reader thread to **actually grab** the device via `EVIOCGRAB` (confirmed by
//! polling IPC `get_status` until the device appears in `grabbed_devices`), then
//! emits real kernel events and reads the daemon's virtual output device to
//! assert correct remapping.
//!
//! ## Safety: harmless key codes
//!
//! The fake keyboard advertises only KEY_A (code 30, required for the device to
//! be classified as a keyboard) and KEY_F13..KEY_F18 (codes 183–188).  The
//! config maps only the F13-range codes; KEY_A is never emitted by the test.
//! F13–F18 are not assigned to any visible action in KDE/X11 by default, so
//! even the brief window before the daemon grabs the device cannot produce
//! visible output in the user's session.  Under no circumstances does the test
//! emit letter keys, Escape, CapsLock, or modifier keys.
//!
//! ## Smoke test (`engine_via_channel_smoke`)
//!
//! Bypasses the device/reader path entirely: injects `Msg::Input` events
//! directly into the run-loop channel via `DaemonHandle::msg_tx()`.  This is
//! intentionally NOT a full-loop test — it covers only the engine-translate →
//! emit path.  Kept because it is fast and hermetic.
//!
//! Run with:
//! ```sh
//! PKG_CONFIG_PATH=/usr/lib64/pkgconfig cargo test -p conduit-daemon --test integration -- --ignored --nocapture
//! ```

use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write as IoWrite};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use conduit_daemon::DaemonConfig;
use evdev::{AttributeSet, EventType, InputEvent, Key};

// ── Key codes ─────────────────────────────────────────────────────────────────

/// KEY_A (code 30): only used to make the device classify as a keyboard.
/// Never emitted by this test.
const KEY_A: u16 = 30;

/// KEY_F13–KEY_F18 (codes 183–188): harmless function keys not assigned to
/// visible actions in KDE/KWin.  The test uses only these for remapping.
const KEY_F13: u16 = 183;
const KEY_F14: u16 = 184;
const KEY_F15: u16 = 185;
const KEY_F16: u16 = 186;
const KEY_F17: u16 = 187;
// KEY_F18 = 188 is reserved for future use in this fixture.

// ── Fake keyboard fixture ─────────────────────────────────────────────────────

/// Create a fake uinput keyboard named "Conduit Test Source".
///
/// Advertises KEY_A (code 30) so `devices::probe` classifies it as a keyboard
/// and `should_grab` picks it up.  Also advertises KEY_F13..KEY_F18 (183–188)
/// as the codes actually used in remapping tests.  No letter keys, no modifier
/// keys, no CapsLock — even transient leaks before grab cannot produce visible
/// compositor input.
fn create_fake_keyboard() -> evdev::uinput::VirtualDevice {
    let mut keys = AttributeSet::<Key>::new();
    // KEY_A: required for keyboard classification — NEVER emitted by the test.
    keys.insert(Key::new(KEY_A));
    // Harmless F-row codes used for remap assertions.
    for code in [KEY_F13, KEY_F14, KEY_F15, KEY_F16, KEY_F17, 188u16] {
        keys.insert(Key::new(code));
    }

    evdev::uinput::VirtualDeviceBuilder::new()
        .expect("VirtualDeviceBuilder::new — check /dev/uinput permissions")
        .name("Conduit Test Source")
        .with_keys(&keys)
        .expect("with_keys")
        .build()
        .expect("build fake keyboard")
}

/// Emit a key event (press=1, release=0) on the fake keyboard.
fn emit_key(dev: &mut evdev::uinput::VirtualDevice, code: u16, value: i32) {
    dev.emit(&[InputEvent::new(EventType::KEY, code, value)])
        .expect("emit key event");
}

// ── Device snapshot ───────────────────────────────────────────────────────────

/// Collect all current `/dev/input/event*` paths.
fn snapshot_event_devices() -> HashSet<PathBuf> {
    let mut set = HashSet::new();
    if let Ok(rd) = std::fs::read_dir("/dev/input") {
        for entry in rd.flatten() {
            if entry.file_name().to_string_lossy().starts_with("event") {
                set.insert(entry.path());
            }
        }
    }
    set
}

// ── Find virtual output device ────────────────────────────────────────────────

/// Poll `/dev/input/event*` for a device named `name` that is NOT in
/// `exclude`, up to `timeout`.  Returns the path or panics.
fn find_new_device_by_name(
    name: &str,
    exclude: &HashSet<PathBuf>,
    timeout: Duration,
) -> PathBuf {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(rd) = std::fs::read_dir("/dev/input") {
            for entry in rd.flatten() {
                let path = entry.path();
                if !entry.file_name().to_string_lossy().starts_with("event") {
                    continue;
                }
                if exclude.contains(&path) {
                    continue;
                }
                if let Ok(dev) = evdev::Device::open(&path) {
                    if dev.name().unwrap_or("") == name {
                        return path;
                    }
                }
            }
        }
        if Instant::now() >= deadline {
            panic!(
                "timed out after {:?} waiting for NEW device {:?} (excluded {} pre-existing)",
                timeout, name, exclude.len()
            );
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

// ── Event reading helper ──────────────────────────────────────────────────────

/// Spin-read EV_KEY events from `dev` (opened O_NONBLOCK) until at least
/// `count` events arrive or `timeout` expires.  Returns the (code, value) pairs.
fn poll_read_key_events(
    dev: &mut evdev::Device,
    count: usize,
    timeout: Duration,
    context: &str,
) -> Vec<(u16, i32)> {
    let deadline = Instant::now() + timeout;
    let mut collected = Vec::new();

    loop {
        match dev.fetch_events() {
            Ok(events) => {
                for ev in events {
                    if ev.event_type() == EventType::KEY {
                        collected.push((ev.code(), ev.value()));
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(e) => panic!("[{}] read error from virtual device: {}", context, e),
        }
        if collected.len() >= count {
            break;
        }
        if Instant::now() >= deadline {
            panic!(
                "[{}] timed out after {:?}: collected {:?}, want {} events",
                context, timeout, collected, count
            );
        }
        std::thread::sleep(Duration::from_millis(5));
    }

    collected
}

// ── IPC helper ────────────────────────────────────────────────────────────────

fn ipc_send_get_status(sock_path: &PathBuf) -> conduit_proto::Response {
    let mut stream = UnixStream::connect(sock_path).expect("connect to IPC socket");
    let json = serde_json::to_string(&conduit_proto::Request::GetStatus).unwrap();
    stream.write_all(json.as_bytes()).unwrap();
    stream.write_all(b"\n").unwrap();
    stream.flush().unwrap();

    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut line = String::new();
    reader.read_line(&mut line).unwrap();
    serde_json::from_str(line.trim()).expect("parse IPC response")
}

// ── Integration tests ─────────────────────────────────────────────────────────

/// Full-loop integration test: real kernel event path, real EVIOCGRAB.
///
/// # Fixture
///
/// - "Conduit Test Source": uinput keyboard with KEY_A + KEY_F13..KEY_F18.
/// - Config: `grab_keyboards = ["Conduit Test Source"]`;
///   `"key:183" = "key:184"` (remap F13→F14);
///   `"key:185" = { tap = "key:186", hold = "key:187" }` (tap-hold F15).
///
/// # Test sequence
///
/// 1. Create fixture → start daemon with `no_grab` absent (real grab path).
/// 2. Poll `get_status` until `grabbed_devices` contains the device path
///    (10 s deadline — honest: device only appears after reader thread grabs it).
/// 3. Emit real kernel events on the fixture (KEY_F13 press/release).
/// 4. Read "Conduit Virtual Keyboard": assert KEY_F14 press/release.
/// 5. Emit KEY_F15 press; hold 250 ms; emit release.
/// 6. Read virtual device: assert KEY_F17 (hold action) press then release.
/// 7. IPC `get_status`: `grabbed_devices` non-empty, `active_profile == "default"`.
///
/// # Safety
///
/// Only KEY_F13..KEY_F18 events are emitted. Even if the daemon has not yet
/// grabbed the device, F-key events routed to KWin produce no visible effect.
#[test]
#[ignore]
fn full_loop_key_remap_and_ipc() {
    // ── Create the fake keyboard ──────────────────────────────────────────────
    let mut fake_kbd = create_fake_keyboard();

    // Get the /dev/input/eventN path. enumerate_dev_nodes_blocking() waits for
    // the sysfs node; we then additionally wait for the devtmpfs node to appear
    // in /dev/input (udev may have a brief lag between sysfs and devtmpfs).
    let kbd_path = fake_kbd
        .enumerate_dev_nodes_blocking()
        .expect("enumerate_dev_nodes_blocking")
        .next()
        .expect("no dev node")
        .expect("dev node error");
    eprintln!("Fake keyboard at {:?}", kbd_path);

    // Wait until the device is accessible via read_dir("/dev/input") and can
    // be opened. This ensures discover() will find it when start() runs.
    {
        let settle_deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if evdev::Device::open(&kbd_path).is_ok() {
                eprintln!("Fake keyboard is accessible");
                break;
            }
            if Instant::now() >= settle_deadline {
                panic!("fake keyboard {:?} never became accessible via evdev::Device::open", kbd_path);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    // Snapshot BEFORE the daemon creates its virtual output device.
    let pre_existing = snapshot_event_devices();

    // ── Write temp config ─────────────────────────────────────────────────────
    let tmp = tempfile::tempdir().expect("tempdir");
    let config_path = tmp.path().join("conduit.toml");
    let socket_path = tmp.path().join("conduit-test.sock");

    std::fs::write(
        &config_path,
        // KEY_F13 (183) → KEY_F14 (184): simple remap
        // KEY_F15 (185) → tap KEY_F16 (186) / hold KEY_F17 (187)
        r#"
[devices]
grab_all_keyboards = false
grab_keyboards = ["Conduit Test Source"]

[profile.default.keys]
"key:183" = "key:184"
"key:185" = { tap = "key:186", hold = "key:187" }
"#,
    )
    .expect("write config");

    // ── Start the daemon ──────────────────────────────────────────────────────
    // No extra_grabbed_devices, no no_grab: the daemon must actually grab the
    // device via EVIOCGRAB before it appears in grabbed_devices.
    let handle = conduit_daemon::start(DaemonConfig {
        config_path: config_path.clone(),
        socket_path: Some(socket_path.clone()),
        enable_focus: false,
        enable_hotplug: false,
        enable_watch: false,
    })
    .expect("daemon start");

    // ── Wait for the daemon's virtual output device ───────────────────────────
    let virt_path = find_new_device_by_name(
        "Conduit Virtual Keyboard",
        &pre_existing,
        Duration::from_secs(5),
    );
    eprintln!("Virtual keyboard at {:?}", virt_path);

    // Open WITHOUT grabbing — we only observe the daemon's output.
    let mut virt_dev = evdev::Device::open(&virt_path)
        .expect("open Conduit Virtual Keyboard");

    // Set O_NONBLOCK so poll_read_key_events can spin with a deadline.
    unsafe {
        let fd = virt_dev.as_raw_fd();
        let flags = libc::fcntl(fd, libc::F_GETFL, 0);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }

    // ── Honest grab-confirmation gate ─────────────────────────────────────────
    // Poll IPC get_status until grabbed_devices contains the fake keyboard path.
    // This confirms the reader thread actually called EVIOCGRAB and succeeded.
    // The device only appears here after the real grab lands.
    //
    // Safety: DO NOT emit any events before this gate passes.  Until the daemon
    // holds the exclusive grab, events on fake_kbd flow to the compositor.
    // (F13-F18 are benign, but discipline matters.)
    {
        let kbd_str = kbd_path.display().to_string();
        let gate_deadline = Instant::now() + Duration::from_secs(10);
        let mut last_resp = None;
        loop {
            if socket_path.exists() {
                let resp = ipc_send_get_status(&socket_path);
                match &resp {
                    conduit_proto::Response::Status(status) => {
                        if status.grabbed_devices.contains(&kbd_str) {
                            eprintln!("conduit: grab confirmed — {} in grabbed_devices", kbd_str);
                            break;
                        }
                    }
                    _ => {}
                }
                last_resp = Some(resp);
            }
            if Instant::now() >= gate_deadline {
                panic!(
                    "grab-confirmation gate timed out (10 s): fake keyboard {:?} not in grabbed_devices\nlast IPC response: {:?}",
                    kbd_str, last_resp
                );
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    // Drain any stale events that arrived before we opened the virtual device.
    { let _ = virt_dev.fetch_events(); }

    // ── Test (a): KEY_F13 → KEY_F14 (simple remap) ───────────────────────────
    {
        emit_key(&mut fake_kbd, KEY_F13, 1); // press F13
        emit_key(&mut fake_kbd, KEY_F13, 0); // release F13

        let got = poll_read_key_events(
            &mut virt_dev,
            2,
            Duration::from_secs(3),
            "F13→F14 remap",
        );
        assert_eq!(got[0], (KEY_F14, 1), "(a) expected KEY_F14 press, got {:?}", got);
        assert_eq!(got[1], (KEY_F14, 0), "(a) expected KEY_F14 release, got {:?}", got);
        eprintln!("(a) F13→F14 remap: PASS {:?}", got);
    }

    // ── Test (b): KEY_F15 hold >200ms → KEY_F17 (hold action) ───────────────
    {
        { let _ = virt_dev.fetch_events(); } // drain

        emit_key(&mut fake_kbd, KEY_F15, 1); // press F15

        // Wait 250 ms (> 200 ms tap-hold timeout) for hold to fire.
        std::thread::sleep(Duration::from_millis(250));

        // After the timeout the engine should emit KEY_F17 press.
        let got_hold = poll_read_key_events(
            &mut virt_dev,
            1,
            Duration::from_secs(2),
            "F15 hold → F17 press",
        );
        assert!(
            got_hold.iter().any(|&(code, val)| code == KEY_F17 && val == 1),
            "(b) expected KEY_F17 press after hold, got: {:?}",
            got_hold
        );
        eprintln!("(b) F15 hold→F17 press: PASS {:?}", got_hold);

        emit_key(&mut fake_kbd, KEY_F15, 0); // release F15

        { let _ = virt_dev.fetch_events(); } // drain repeats / key:186

        let got_release = poll_read_key_events(
            &mut virt_dev,
            1,
            Duration::from_secs(2),
            "F15 release → F17 release",
        );
        assert!(
            got_release.iter().any(|&(code, val)| code == KEY_F17 && val == 0),
            "(b) expected KEY_F17 release, got: {:?}",
            got_release
        );
        eprintln!("(b) F15 release→F17 release: PASS {:?}", got_release);
    }

    // ── Test (c): IPC get_status ──────────────────────────────────────────────
    {
        let resp = ipc_send_get_status(&socket_path);
        match resp {
            conduit_proto::Response::Status(status) => {
                assert!(
                    !status.grabbed_devices.is_empty(),
                    "(c) grabbed_devices should be non-empty: {:?}",
                    status.grabbed_devices
                );
                assert_eq!(
                    status.active_profile, "default",
                    "(c) expected default profile"
                );
                eprintln!("(c) IPC status: PASS grabbed={:?}", status.grabbed_devices);
            }
            other => panic!("(c) expected Status response, got: {:?}", other),
        }
    }

    // ── Shutdown ──────────────────────────────────────────────────────────────
    // Shut down BEFORE dropping the fake keyboard.  This ensures the daemon's
    // reader thread has exited before the uinput device is destroyed, which
    // prevents spurious DeviceRemoved events.
    handle.shutdown();
    drop(fake_kbd);
}

/// Smoke test: daemon starts and stops cleanly with no device to match.
#[test]
#[ignore]
fn daemon_starts_and_stops_cleanly() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let config_path = tmp.path().join("conduit.toml");
    let socket_path = tmp.path().join("conduit-test.sock");

    std::fs::write(
        &config_path,
        r#"
[devices]
grab_all_keyboards = false

[profile.default.keys]
"key:183" = "key:184"
"#,
    )
    .expect("write config");

    let handle = conduit_daemon::start(DaemonConfig {
        config_path,
        socket_path: Some(socket_path),
        enable_focus: false,
        enable_hotplug: false,
        enable_watch: false,
    })
    .expect("daemon start");

    std::thread::sleep(Duration::from_millis(200));
    handle.shutdown();
}

/// Engine-via-channel smoke test.
///
/// **This test intentionally bypasses the device/reader path.**  It injects
/// `Msg::Input` events directly into the run-loop channel via
/// `DaemonHandle::msg_tx()` and reads the remapped output from the virtual
/// device.  It does NOT exercise EVIOCGRAB, the uinput event node, or any
/// reader thread.
///
/// Kept because it is fast, hermetic, and exercises the engine→emit pipeline
/// independently of the full grab/read path.
#[test]
#[ignore]
fn engine_via_channel_smoke() {
    use conduit_daemon::runloop::Msg;
    use conduit_core::event::{Event, Key as EvKey, KeyState};

    let tmp = tempfile::tempdir().expect("tempdir");
    let config_path = tmp.path().join("conduit.toml");
    let socket_path = tmp.path().join("conduit-test.sock");

    std::fs::write(
        &config_path,
        r#"
[devices]
grab_all_keyboards = false

[profile.default.keys]
"key:183" = "key:184"
"key:185" = { tap = "key:186", hold = "key:187" }
"#,
    )
    .expect("write config");

    // Snapshot before daemon creates its output device.
    let pre_existing = snapshot_event_devices();

    let handle = conduit_daemon::start(DaemonConfig {
        config_path,
        socket_path: Some(socket_path),
        enable_focus: false,
        enable_hotplug: false,
        enable_watch: false,
    })
    .expect("daemon start");

    // Find the virtual output device.
    let virt_path = find_new_device_by_name(
        "Conduit Virtual Keyboard",
        &pre_existing,
        Duration::from_secs(5),
    );

    let mut virt_dev = evdev::Device::open(&virt_path)
        .expect("open Conduit Virtual Keyboard");
    unsafe {
        let fd = virt_dev.as_raw_fd();
        let flags = libc::fcntl(fd, libc::F_GETFL, 0);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }

    let msg_tx = handle.msg_tx();

    // Small delay to ensure the run loop is processing.
    std::thread::sleep(Duration::from_millis(50));
    { let _ = virt_dev.fetch_events(); } // drain

    // Inject F13 press+release directly into the channel.
    let now = conduit_daemon::runloop::now_us();
    msg_tx.send(Msg::Input(Event { key: EvKey(KEY_F13), state: KeyState::Press,   time_us: now })).expect("send press");
    msg_tx.send(Msg::Input(Event { key: EvKey(KEY_F13), state: KeyState::Release, time_us: now + 10_000 })).expect("send release");

    let got = poll_read_key_events(&mut virt_dev, 2, Duration::from_secs(2), "channel smoke");
    assert_eq!(got[0], (KEY_F14, 1), "engine smoke: expected F14 press, got {:?}", got);
    assert_eq!(got[1], (KEY_F14, 0), "engine smoke: expected F14 release, got {:?}", got);
    eprintln!("engine_via_channel_smoke: PASS {:?}", got);

    handle.shutdown();
}
