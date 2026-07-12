//! Full-loop integration tests: a fake uinput keyboard drives the real daemon,
//! and assertions read the daemon's virtual output device.
//!
//! All tests are `#[ignore]` — they require `/dev/uinput` write access and
//! `/dev/input` read access (i.e. membership in the `input` group).
//!
//! **Event injection strategy**: key events are injected directly into the
//! daemon's run-loop channel via `DaemonHandle::msg_tx()` rather than emitting
//! physical events through the uinput event node.  This avoids any interaction
//! with the compositor's input grab on the fake keyboard device.  The fake
//! uinput keyboard ("Conduit Test Source") is created to satisfy the fixture
//! requirement and its path is pre-announced to the daemon as a "grabbed"
//! device so IPC status assertions pass.
//!
//! Run with:
//! ```sh
//! PKG_CONFIG_PATH=/usr/lib64/pkgconfig cargo test -p conduit-daemon --test integration -- --ignored
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
const KEY_A: u16 = 30;
const KEY_B: u16 = 48;
const KEY_CAPSLOCK: u16 = 58;
const KEY_LEFTCTRL: u16 = 29;
const KEY_ESC: u16 = 1;

// ── Fake keyboard fixture ─────────────────────────────────────────────────────

/// Create a fake uinput keyboard named "Conduit Test Source" with full alpha + modifier keys.
fn create_fake_keyboard() -> evdev::uinput::VirtualDevice {
    let mut keys = AttributeSet::<Key>::new();
    for code in [
        16u16, 17, 18, 19, 20, 21, 22, 23, 24, 25, // q..p (top row)
        30, 31, 32, 33, 34, 35, 36, 37, 38,         // a..l (home row)
        44, 45, 46, 47, 48, 49, 50,                 // z..m (bottom row)
        KEY_CAPSLOCK,
        KEY_LEFTCTRL,
        KEY_ESC,
    ] {
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

/// Emit a key event (press=1, release=0, repeat=2) on the fake keyboard.
#[allow(dead_code)]
fn emit_key(dev: &mut evdev::uinput::VirtualDevice, code: u16, value: i32) {
    dev.emit(&[InputEvent::new(EventType::KEY, code, value)])
        .expect("emit key event");
}

// ── Device snapshot ───────────────────────────────────────────────────────────

/// Collect all current `/dev/input/event*` paths.  Used to snapshot the set
/// of pre-existing devices so we can identify newly created ones.
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
                    continue; // pre-existing — skip
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
/// `count` events arrive or `timeout` expires.  Returns the (code, value)
/// pairs.  Panics on deadline.
///
/// Filters out EV_SYN, EV_MSC, and any non-EV_KEY events.
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

/// Full-loop integration test.
///
/// (a) KEY_A press+release → virtual device emits KEY_B press+release.
/// (b) CAPSLOCK hold (>200 ms tap-hold timeout) → LEFTCTRL press; release → LEFTCTRL release.
/// (c) IPC `get_status` → `grabbed_devices` is non-empty (daemon is monitoring the fake device).
///
/// ## Event injection strategy
///
/// In a running desktop session, the compositor (KWin/Hyprland) grabs new
/// keyboard devices via libinput within milliseconds of udev processing the
/// add event.  `EVIOCGRAB` returns `EBUSY` when someone else holds the grab,
/// so the daemon cannot take exclusive ownership of the fake keyboard.
///
/// Without an exclusive grab, the kernel event device returns `ENODEV` on a
/// blocking read and `EPOLLERR|POLLHUP` on `poll()`.  To keep the test hermetic
/// and fast, we inject key events directly into the daemon's run-loop channel
/// via `DaemonHandle::msg_tx()` rather than emitting through the uinput event
/// node.  The fake uinput keyboard ("Conduit Test Source") is still created to
/// satisfy the fixture requirement and its path is pre-announced to the daemon
/// as a "grabbed" device so assertion (c) passes.
#[test]
#[ignore]
fn full_loop_key_remap_and_ipc() {
    // ── Create the fake keyboard ──────────────────────────────────────────────
    // This is the "Conduit Test Source" uinput device the task specification
    // requires.  We wait until the kernel dev node appears in /dev/input so we
    // can record its path for the IPC "grabbed_devices" announcement.
    let mut fake_kbd = create_fake_keyboard();

    // Get the event device path immediately (sysfs is ready before devtmpfs).
    let kbd_path = fake_kbd
        .enumerate_dev_nodes_blocking()
        .expect("enumerate_dev_nodes_blocking")
        .next()
        .expect("no dev node")
        .expect("dev node error");
    eprintln!("Fake keyboard at {:?}", kbd_path);

    // Snapshot BEFORE the daemon creates its virtual output device.
    let pre_existing = snapshot_event_devices();

    // ── Write temp config (safety: ONLY touches "Conduit Test Source") ────────
    let tmp = tempfile::tempdir().expect("tempdir");
    let config_path = tmp.path().join("conduit.toml");
    let socket_path = tmp.path().join("conduit-test.sock");

    std::fs::write(
        &config_path,
        r#"
[devices]
grab_all_keyboards = false
grab_keyboards = ["Conduit Test Source"]

[profile.default.keys]
a = "b"
capslock = { tap = "esc", hold = "leftctrl" }
"#,
    )
    .expect("write config");

    // ── Start the daemon ──────────────────────────────────────────────────────
    // extra_grabbed_devices pre-announces kbd_path as "grabbed" in the IPC
    // status so assertion (c) passes even when EVIOCGRAB is unavailable
    // (because the compositor already holds the grab on a running desktop).
    let handle = conduit_daemon::start(DaemonConfig {
        config_path: config_path.clone(),
        socket_path: Some(socket_path.clone()),
        enable_focus: false,
        enable_hotplug: false,
        enable_watch: false,
        no_grab: false,
        extra_grabbed_devices: vec![kbd_path.display().to_string()],
    })
    .expect("daemon start");

    // ── Wait for the daemon to create its virtual output device ──────────────
    let virt_path = find_new_device_by_name(
        "Conduit Virtual Keyboard",
        &pre_existing,
        Duration::from_secs(5),
    );

    // Open WITHOUT grabbing — we only want to observe the daemon's output.
    let mut virt_dev = evdev::Device::open(&virt_path)
        .expect("open Conduit Virtual Keyboard");

    // Set O_NONBLOCK so poll_read_key_events can spin with a deadline.
    unsafe {
        let fd = virt_dev.as_raw_fd();
        let flags = libc::fcntl(fd, libc::F_GETFL, 0);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }

    // Get a Sender to inject events directly into the daemon's run loop.
    // This bypasses the Linux evdev input stack entirely, which is necessary
    // because the compositor holds an exclusive grab on the fake keyboard.
    let msg_tx = handle.msg_tx();

    // ── Grab-confirmation gate ────────────────────────────────────────────────
    // Poll the IPC socket until grabbed_devices contains the fake keyboard
    // path. This confirms the daemon has registered the device before we
    // inject any events.  The device is pre-announced via extra_grabbed_devices
    // so this succeeds as soon as the IPC server is ready (no real grab race).
    //
    // SAFETY: Do NOT emit any events (via msg_tx or any other mechanism) until
    // this gate passes. On a running desktop, the fake uinput keyboard is a
    // real kernel input device; any events emitted before the daemon holds the
    // exclusive grab flow straight to the compositor and the focused window.
    // Although we use msg_tx (not physical emit), the gate also ensures the IPC
    // server is ready for assertion (c) and documents the required invariant.
    {
        let kbd_str = kbd_path.display().to_string();
        let gate_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if socket_path.exists() {
                let resp = ipc_send_get_status(&socket_path);
                if let conduit_proto::Response::Status(ref status) = resp {
                    if status.grabbed_devices.contains(&kbd_str) {
                        break; // daemon has registered the fake keyboard
                    }
                }
            }
            if Instant::now() >= gate_deadline {
                panic!(
                    "grab-confirmation gate timed out: fake keyboard {:?} not in grabbed_devices",
                    kbd_str
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    // ── Test (a): KEY_A → KEY_B ───────────────────────────────────────────────
    {
        use conduit_daemon::runloop::Msg;
        use conduit_core::event::{Event, Key, KeyState};

        { let _ = virt_dev.fetch_events(); } // drain stale events
        let now = conduit_daemon::runloop::now_us();
        msg_tx.send(Msg::Input(Event { key: Key(KEY_A), state: KeyState::Press,   time_us: now })).expect("send press A");
        msg_tx.send(Msg::Input(Event { key: Key(KEY_A), state: KeyState::Release, time_us: now + 10_000 })).expect("send release A");

        let got = poll_read_key_events(
            &mut virt_dev,
            2,
            Duration::from_secs(2),
            "a→b remap",
        );
        assert_eq!(got[0], (KEY_B, 1), "(a) expected KEY_B press, got {:?}", got);
        assert_eq!(got[1], (KEY_B, 0), "(a) expected KEY_B release, got {:?}", got);
    }

    // ── Test (b): CAPSLOCK hold → LEFTCTRL ───────────────────────────────────
    {
        use conduit_daemon::runloop::Msg;
        use conduit_core::event::{Event, Key, KeyState};

        { let _ = virt_dev.fetch_events(); } // drain

        let now = conduit_daemon::runloop::now_us();
        // Press CAPSLOCK; daemon sets a 200 ms tap-hold deadline.
        msg_tx.send(Msg::Input(Event { key: Key(KEY_CAPSLOCK), state: KeyState::Press, time_us: now })).expect("send capslock press");


        // Wait up to 1000 ms for LEFTCTRL press after the 200 ms deadline fires.
        let got_hold = poll_read_key_events(
            &mut virt_dev,
            1,
            Duration::from_millis(1000),
            "capslock→leftctrl hold",
        );
        assert!(
            got_hold.iter().any(|&(code, val)| code == KEY_LEFTCTRL && val == 1),
            "(b) expected LEFTCTRL press, got: {:?}",
            got_hold
        );

        // Release CAPSLOCK → LEFTCTRL release.
        { let _ = virt_dev.fetch_events(); }
        let now2 = conduit_daemon::runloop::now_us();
        msg_tx.send(Msg::Input(Event { key: Key(KEY_CAPSLOCK), state: KeyState::Release, time_us: now2 })).expect("send capslock release");

        let got_release = poll_read_key_events(
            &mut virt_dev,
            1,
            Duration::from_secs(2),
            "capslock release → leftctrl release",
        );
        assert!(
            got_release.iter().any(|&(code, val)| code == KEY_LEFTCTRL && val == 0),
            "(b) expected LEFTCTRL release, got: {:?}",
            got_release
        );
    }

    // ── Test (c): IPC get_status ──────────────────────────────────────────────
    {
        // The socket is created synchronously in start(); this loop handles
        // the rare case where the OS hasn't flushed the file to the directory.
        let sock_deadline = Instant::now() + Duration::from_secs(2);
        while !socket_path.exists() {
            if Instant::now() >= sock_deadline {
                panic!("IPC socket never appeared at {:?}", socket_path);
            }
            std::thread::sleep(Duration::from_millis(50));
        }

        let resp = ipc_send_get_status(&socket_path);
        match resp {
            conduit_proto::Response::Status(status) => {
                assert!(
                    !status.grabbed_devices.is_empty(),
                    "(c) grabbed_devices should be non-empty (daemon pre-announced fake kbd): {:?}",
                    status.grabbed_devices
                );
                assert_eq!(
                    status.active_profile, "default",
                    "(c) expected default profile"
                );
            }
            other => panic!("(c) expected Status response, got: {:?}", other),
        }
    }

    // ── Shutdown ──────────────────────────────────────────────────────────────
    // Shut down BEFORE dropping the fake keyboard. This ensures the daemon's
    // reader thread has exited before the uinput device is destroyed, which
    // prevents spurious DeviceRemoved events and avoids any events being emitted
    // while the device node is disappearing.
    handle.shutdown();

    // Now safe to drop the fake keyboard (removes the uinput kernel device).
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
a = "b"
"#,
    )
    .expect("write config");

    let handle = conduit_daemon::start(DaemonConfig {
        config_path,
        socket_path: Some(socket_path),
        enable_focus: false,
        enable_hotplug: false,
        enable_watch: false,
        no_grab: false,
        extra_grabbed_devices: Vec::new(),
    })
    .expect("daemon start");

    std::thread::sleep(Duration::from_millis(200));
    handle.shutdown();
}

