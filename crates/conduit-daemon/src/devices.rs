use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use crossbeam_channel::Sender;

use conduit_core::config::Settings;
use conduit_core::event::{Event, Key, KeyState};

use crate::output::VirtualOutput;
use crate::runloop::{now_us, Msg};

/// A discovered input device with its classification.
#[derive(Debug, Clone)]
pub struct Discovered {
    pub path: PathBuf,
    pub name: String,
    pub vendor: u16,
    pub product: u16,
    pub is_keyboard: bool,
    pub is_mouse: bool,
}

/// Probe a single device path and return a `Discovered` entry, or `None` if the
/// device cannot be opened / read (e.g. permission error or not an input device)
/// or if it is a Conduit Virtual device.
pub fn probe(path: PathBuf) -> Option<Discovered> {
    let dev = evdev::Device::open(&path).ok()?;

    let name = dev.name().unwrap_or("").to_owned();

    // Exclude Conduit Virtual devices at discovery time.
    if name.starts_with("Conduit Virtual") {
        return None;
    }

    let id = dev.input_id();
    let vendor = id.vendor();
    let product = id.product();

    // Classification:
    //   keyboard = supports EV_KEY and has KEY_A
    //   mouse    = supports EV_KEY with BTN_LEFT and EV_REL
    let supported_keys = dev.supported_keys();
    let has_ev_key = supported_keys.is_some();
    let has_key_a = supported_keys
        .as_ref()
        .map_or(false, |keys| keys.contains(evdev::Key::KEY_A));
    let has_btn_left = supported_keys
        .as_ref()
        .map_or(false, |keys| keys.contains(evdev::Key::BTN_LEFT));
    let has_ev_rel = dev
        .supported_relative_axes()
        .is_some();

    let is_keyboard = has_ev_key && has_key_a;
    let is_mouse = has_ev_key && has_btn_left && has_ev_rel;

    Some(Discovered {
        path,
        name,
        vendor,
        product,
        is_keyboard,
        is_mouse,
    })
}

/// Enumerate all input devices under `/dev/input/event*` and classify each one.
/// Devices whose name starts with `"Conduit Virtual"` are excluded.
pub fn discover() -> anyhow::Result<Vec<Discovered>> {
    let mut results = Vec::new();

    for (path, _dev) in evdev::enumerate() {
        if let Some(d) = probe(path) {
            results.push(d);
        }
    }

    Ok(results)
}

/// Scan `/dev/input/event*` with `read_dir` and return the paths of nodes that
/// fail to open with `PermissionDenied`.  This is used to detect the situation
/// where `evdev::enumerate()` returned an empty list *because* the user has no
/// access to any input device — evdev silently skips devices it can't open.
pub fn eacces_blocked_event_nodes() -> Vec<std::path::PathBuf> {
    eacces_blocked_event_nodes_in("/dev/input")
}

/// Testable inner implementation: scans `dir` for files whose names start with
/// `"event"` and returns those that fail to open with `PermissionDenied`.
pub fn eacces_blocked_event_nodes_in(dir: &str) -> Vec<std::path::PathBuf> {
    let mut blocked = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return blocked;
    };
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("event") {
            continue;
        }
        if let Err(e) = std::fs::File::open(&path) {
            if e.kind() == std::io::ErrorKind::PermissionDenied {
                blocked.push(path);
            }
        }
    }
    blocked.sort();
    blocked
}

/// Pure decision function: given the number of discovered devices and the
/// number of EACCES-blocked event nodes, returns `true` when the daemon
/// should print the permissions error and exit 2.
///
/// This exists to allow unit-testing the logic without touching the filesystem.
pub fn should_fail_eacces(discovered_count: usize, eacces_count: usize) -> bool {
    discovered_count == 0 && eacces_count > 0
}

/// Determine whether a discovered device should be grabbed based on the loaded
/// `Settings`.
///
/// Rules:
/// - Any device whose name starts with `"Conduit Virtual"` → `false` (defense in depth).
/// - Keyboards: grabbed if `grab_all_keyboards` is set, or if the device name
///   appears in `grab_keyboards`.
/// - Mice: grabbed if the device name appears in `grab_mice` (exact match).
/// - Devices that are neither keyboard nor mouse → `false`.
pub fn should_grab(d: &Discovered, s: &Settings) -> bool {
    // Defense in depth: never grab Conduit Virtual devices.
    if d.name.starts_with("Conduit Virtual") {
        return false;
    }

    let mut grab = false;

    if d.is_keyboard {
        if s.grab_all_keyboards || s.grab_keyboards.iter().any(|k| k == &d.name) {
            grab = true;
        }
    }

    if d.is_mouse {
        if s.grab_mice.iter().any(|m| m == &d.name) {
            grab = true;
        }
    }

    grab
}

// ── Reader threads ────────────────────────────────────────────────────────────

/// Handle for a spawned reader thread and its device grab.
///
/// Ungrab/close mechanism: the `evdev::Device` (and its `EVIOCGRAB`) is owned
/// by the reader thread. Dropping a `GrabHandle` sets the shared stop flag and
/// joins the thread; when the thread exits, the `Device` drops, which closes
/// the fd and releases the kernel grab. Caveat: a thread blocked in
/// `fetch_events()` only observes the stop flag after the next event batch
/// arrives; in practice handles are dropped at process exit (the OS reclaims
/// fds and grabs) or after the reader has already exited on a device error.
pub struct GrabHandle {
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for GrabHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.thread.take() {
            let _ = h.join();
        }
    }
}

/// Spawn a reader thread for one device to grab.
///
/// The thread opens the device at `path`, grabs it, then loops
/// `fetch_events()`:
/// - EV_KEY events become core `Event`s (value 1 = Press, 0 = Release,
///   2 = Repeat), stamped with `now_us()` at read time, sent as `Msg::Input`.
/// - For mice (`is_mouse`): EV_REL and EV_MSC events are forwarded directly
///   to the virtual mouse via `out` — motion latency must not pay a channel
///   hop. EV_SYN is NOT forwarded: `VirtualDevice::emit` auto-appends
///   SYN_REPORT and forwarding SYN would double it.
/// - On a read error (device unplugged) the thread sends
///   `Msg::DeviceRemoved(path)` and exits.
pub fn spawn_reader(
    path: PathBuf,
    is_mouse: bool,
    tx: Sender<Msg>,
    out: Arc<Mutex<VirtualOutput>>,
) -> GrabHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = Arc::clone(&stop);

    let thread = std::thread::spawn(move || {
        let mut dev = match evdev::Device::open(&path) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("conduit: failed to open {}: {}", path.display(), e);
                let _ = tx.send(Msg::DeviceRemoved(path));
                return;
            }
        };
        if let Err(e) = dev.grab() {
            eprintln!("conduit: failed to grab {}: {}", path.display(), e);
            let _ = tx.send(Msg::DeviceRemoved(path));
            return;
        }
        let name = dev.name().unwrap_or("unknown").to_owned();
        eprintln!("conduit: grabbed {} ({})", name, path.display());

        while !stop_flag.load(Ordering::Relaxed) {
            let events = match dev.fetch_events() {
                Ok(evs) => evs,
                Err(e) => {
                    eprintln!("conduit: read error on {} ({}): {}", name, path.display(), e);
                    let _ = tx.send(Msg::DeviceRemoved(path));
                    return;
                }
            };
            for raw in events {
                let ev_type = raw.event_type();
                if ev_type == evdev::EventType::KEY {
                    let state = match raw.value() {
                        1 => KeyState::Press,
                        0 => KeyState::Release,
                        2 => KeyState::Repeat,
                        _ => continue,
                    };
                    let ev = Event { key: Key(raw.code()), state, time_us: now_us() };
                    if tx.send(Msg::Input(ev)).is_err() {
                        return; // engine thread gone; shut down
                    }
                } else if is_mouse
                    && (ev_type == evdev::EventType::RELATIVE
                        || ev_type == evdev::EventType::MISC)
                {
                    if let Ok(mut o) = out.lock() {
                        let _ = o.emit_raw_mouse(&raw);
                    }
                }
                // EV_SYN and everything else is dropped (SYN_REPORT is
                // auto-appended by VirtualDevice::emit).
            }
        }
        // Stop requested: Device drops here → fd closes → grab released.
        eprintln!("conduit: released {} ({})", name, path.display());
    });

    GrabHandle { stop, thread: Some(thread) }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn kbd(name: &str) -> Discovered {
        Discovered {
            path: "/dev/input/event0".into(),
            name: name.into(),
            vendor: 0,
            product: 0,
            is_keyboard: true,
            is_mouse: false,
        }
    }

    fn mouse(name: &str) -> Discovered {
        Discovered {
            path: "/dev/input/event1".into(),
            name: name.into(),
            vendor: 0,
            product: 0,
            is_keyboard: false,
            is_mouse: true,
        }
    }

    fn test_settings() -> conduit_core::config::Settings {
        conduit_core::config::compile(
            "[devices]\ngrab_all_keyboards = true\ngrab_mice = [\"Logitech G502\"]",
        )
        .unwrap()
        .settings
    }

    #[test]
    fn grab_selection_rules() {
        let s = test_settings();
        assert!(should_grab(&kbd("AT Translated Set 2 keyboard"), &s));
        assert!(!should_grab(&mouse("Some Mouse"), &s));
        assert!(should_grab(&mouse("Logitech G502"), &s));
        assert!(!should_grab(&kbd("Conduit Virtual Keyboard"), &s)); // never
    }

    #[test]
    fn grab_keyboard_by_exact_name() {
        let s = conduit_core::config::compile(
            "[devices]\ngrab_all_keyboards = false\ngrab_keyboards = [\"My Keyboard\"]",
        )
        .unwrap()
        .settings;
        assert!(should_grab(&kbd("My Keyboard"), &s));
        assert!(!should_grab(&kbd("Other Keyboard"), &s));
    }

    #[test]
    fn conduit_virtual_devices_never_grabbed() {
        let s = conduit_core::config::compile(
            "[devices]\ngrab_all_keyboards = true\ngrab_mice = [\"Conduit Virtual Mouse\"]",
        )
        .unwrap()
        .settings;
        assert!(!should_grab(&kbd("Conduit Virtual Keyboard"), &s));
        assert!(!should_grab(&mouse("Conduit Virtual Mouse"), &s));
    }

    #[test]
    fn non_keyboard_non_mouse_not_grabbed() {
        let s = test_settings();
        let other = Discovered {
            path: "/dev/input/event2".into(),
            name: "Generic HID device".into(),
            vendor: 0,
            product: 0,
            is_keyboard: false,
            is_mouse: false,
        };
        assert!(!should_grab(&other, &s));
    }

    // ── EACCES detection — pure decision logic ────────────────────────────────

    #[test]
    fn eacces_fail_when_no_discovered_and_some_blocked() {
        // Zero discovered devices + at least one EACCES node → should fail.
        assert!(should_fail_eacces(0, 1));
        assert!(should_fail_eacces(0, 5));
    }

    #[test]
    fn eacces_no_fail_when_devices_were_discovered() {
        // Some devices discovered → evdev had access; do not trigger EACCES exit.
        assert!(!should_fail_eacces(1, 0));
        assert!(!should_fail_eacces(3, 2));
        assert!(!should_fail_eacces(1, 5));
    }

    #[test]
    fn eacces_no_fail_when_nothing_blocked() {
        // No blocked nodes (no /dev/input nodes exist, or all are accessible) → ok.
        assert!(!should_fail_eacces(0, 0));
    }
}
