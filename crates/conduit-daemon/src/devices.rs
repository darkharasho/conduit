use std::os::fd::AsRawFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use crossbeam_channel::Sender;

use conduit_core::config::Settings;
use conduit_core::event::{Event, Key, KeyState};

use crate::classify::{classify, Caps, DeviceClass, DeviceSelector};
use crate::output::VirtualOutput;
use crate::runloop::{now_us, Msg};

/// A discovered input device with its classification.
#[derive(Debug, Clone)]
pub struct Discovered {
    pub path: PathBuf,
    pub name: String,
    pub vendor: u16,
    pub product: u16,
    pub phys: String,
    pub class: DeviceClass,
    /// EV_KEY codes the device declares (sorted).
    pub keys: Vec<u16>,
    /// Declares REL_WHEEL / REL_HWHEEL.
    pub wheel: bool,
    pub hwheel: bool,
}

impl Discovered {
    /// Canonical selector: `vid:pid/name`.
    pub fn id(&self) -> String {
        format!("{:04x}:{:04x}/{}", self.vendor, self.product, self.name)
    }
    pub fn is_keyboard(&self) -> bool {
        self.class == DeviceClass::Keyboard
    }
    pub fn is_mouse(&self) -> bool {
        self.class == DeviceClass::Mouse
    }
    /// Pointer-ish devices get their EV_REL/EV_MSC events forwarded raw.
    pub fn is_pointer(&self) -> bool {
        matches!(self.class, DeviceClass::Mouse | DeviceClass::Touchpad)
    }
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

    let keys: Vec<u16> = dev
        .supported_keys()
        .map(|set| set.iter().map(|k| k.code()).collect())
        .unwrap_or_default();
    let rel = dev.supported_relative_axes();
    let rel_x_y = rel.as_ref().map_or(false, |r| {
        r.contains(evdev::RelativeAxisType::REL_X) && r.contains(evdev::RelativeAxisType::REL_Y)
    });
    let wheel = rel
        .as_ref()
        .map_or(false, |r| r.contains(evdev::RelativeAxisType::REL_WHEEL));
    let hwheel = rel
        .as_ref()
        .map_or(false, |r| r.contains(evdev::RelativeAxisType::REL_HWHEEL));
    let abs_x_y = dev.supported_absolute_axes().map_or(false, |a| {
        a.contains(evdev::AbsoluteAxisType::ABS_X) && a.contains(evdev::AbsoluteAxisType::ABS_Y)
    });
    let prop_pointer = dev.properties().contains(evdev::PropType::POINTER);
    let caps = Caps { keys, rel_x_y, abs_x_y, prop_pointer };
    let mut keys = caps.keys.clone();
    keys.sort_unstable();

    Some(Discovered {
        path,
        name,
        vendor: id.vendor(),
        product: id.product(),
        phys: dev.physical_path().unwrap_or("").to_owned(),
        class: classify(&caps),
        keys,
        wheel,
        hwheel,
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
/// - Keyboards: `grab_all_keyboards` or a `grab_keyboards` selector match.
/// - Mice: `grab_all_mice` or a `grab_mice` selector match.
/// - Touchpads: a `grab_mice` selector match ONLY — grabbing a touchpad kills
///   compositor gestures, so `grab_all_mice` never includes them.
/// - Gamepads, media-key nodes, and everything else → `false`.
pub fn should_grab(d: &Discovered, s: &Settings) -> bool {
    // Defense in depth: never grab Conduit Virtual devices.
    if d.name.starts_with("Conduit Virtual") {
        return false;
    }

    let matched = |list: &[String]| {
        list.iter()
            .any(|e| DeviceSelector::parse(e).matches(&d.name, d.vendor, d.product, &d.phys))
    };

    match d.class {
        DeviceClass::Keyboard => s.grab_all_keyboards || matched(&s.grab_keyboards),
        DeviceClass::Mouse => s.grab_all_mice || matched(&s.grab_mice),
        DeviceClass::Touchpad => matched(&s.grab_mice),
        _ => false,
    }
}

// ── Wheel translation ─────────────────────────────────────────────────────────

pub const REL_HWHEEL: u16 = 0x06;
pub const REL_WHEEL: u16 = 0x08;
pub const REL_WHEEL_HI_RES: u16 = 0x0b;
pub const REL_HWHEEL_HI_RES: u16 = 0x0c;

/// Translate a wheel REL event into engine key events: one Press+Release pair
/// of the matching pseudo-key per tick.
pub fn wheel_events(rel_code: u16, value: i32, now: u64) -> Vec<Event> {
    use conduit_core::keys as k;
    let key = match (rel_code, value > 0) {
        (REL_WHEEL, true) => k::WHEEL_UP,
        (REL_WHEEL, false) => k::WHEEL_DOWN,
        (REL_HWHEEL, true) => k::WHEEL_RIGHT,
        (REL_HWHEEL, false) => k::WHEEL_LEFT,
        _ => return Vec::new(),
    };
    if value == 0 {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(value.unsigned_abs() as usize * 2);
    for _ in 0..value.unsigned_abs() {
        out.push(Event { key, state: KeyState::Press, time_us: now });
        out.push(Event { key, state: KeyState::Release, time_us: now });
    }
    out
}

// ── Reader threads ────────────────────────────────────────────────────────────

static NEXT_SOURCE: AtomicU16 = AtomicU16::new(0);

/// Allocate a process-unique source id for a reader thread. The runloop maps
/// source ids to device slots (`classify::resolve_slot`) against the live
/// config's `device_selectors`.
pub fn next_source_id() -> u16 {
    NEXT_SOURCE.fetch_add(1, Ordering::Relaxed)
}

/// Handle for a spawned reader thread and its device grab.
///
/// Ungrab/close mechanism: the `evdev::Device` (and its `EVIOCGRAB`) is owned
/// by the reader thread. Dropping a `GrabHandle` sets the shared stop flag and
/// joins the thread; when the thread exits, the `Device` drops, which closes
/// the fd and releases the kernel grab.
///
/// The reader thread uses `O_NONBLOCK` + `poll(2)` with a 50 ms timeout on the
/// device fd (for grabbed devices) so the stop flag is honoured within
/// milliseconds even when no events are arriving — avoiding a shutdown deadlock
/// where `drop` would otherwise block indefinitely waiting for the next event.
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
/// The thread opens the device at `path`, optionally grabs it (see `do_grab`),
/// then loops `fetch_events()`:
/// - EV_KEY events become core `Event`s (value 1 = Press, 0 = Release,
///   2 = Repeat), stamped with `now_us()` at read time, sent as `Msg::Input`.
/// - For pointer devices (`is_pointer`): EV_REL motion and EV_MSC events are
///   forwarded directly to the virtual mouse via `out` — motion latency must
///   not pay a channel hop. EV_SYN is NOT forwarded: `VirtualDevice::emit`
///   auto-appends SYN_REPORT and forwarding SYN would double it.
/// - On a read error (device unplugged) the thread sends
///   `Msg::DeviceRemoved(path)` and exits.
///
/// `do_grab`: when `true` (the default for production), `EVIOCGRAB` is called to
/// obtain exclusive access so key events do not leak to the compositor.  Set
/// `false` in integration tests that use a `uinput`-created fake keyboard.
///
/// **Kernel limitation**: a uinput-created event device returns `ENODEV` on a
/// *blocking* `read()` if the reader does not hold an exclusive grab.  When
/// `do_grab=false` we set `O_NONBLOCK` and treat `EAGAIN`/`WouldBlock` as
/// "no events yet — sleep briefly and retry".  Events still flow from the
/// uinput fd into the event device and are visible via the non-blocking read.
pub fn spawn_reader(
    path: PathBuf,
    is_pointer: bool,
    do_grab: bool,
    source: u16,
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
        if do_grab {
            if let Err(e) = dev.grab() {
                eprintln!("conduit: failed to grab {}: {}", path.display(), e);
                let _ = tx.send(Msg::DeviceRemoved(path));
                return;
            }
        }

        // Always set O_NONBLOCK regardless of grab mode.
        //
        // For grabbed devices: this enables the poll(2)-with-timeout loop
        // below, which checks the stop flag every 50 ms.  Without O_NONBLOCK
        // the reader would block indefinitely inside fetch_events() and
        // GrabHandle::drop (which joins the thread) would deadlock when no
        // input events are arriving (e.g. at daemon shutdown).
        //
        // For ungrabbed (test) devices: a blocking read on an ungrabbed uinput
        // event device returns ENODEV immediately on Linux; O_NONBLOCK returns
        // EAGAIN/WouldBlock instead, which we handle with a short sleep below.
        {
            let fd = dev.as_raw_fd();
            unsafe {
                let flags = libc::fcntl(fd, libc::F_GETFL, 0);
                libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
            }
        }

        let name = dev.name().unwrap_or("unknown").to_owned();
        if do_grab {
            eprintln!("conduit: grabbed {} ({})", name, path.display());
        } else {
            eprintln!("conduit: monitoring (no-grab) {} ({})", name, path.display());
        }

        while !stop_flag.load(Ordering::Relaxed) {
            if do_grab {
                // poll(2) with a 50 ms timeout: block until the fd becomes
                // readable or the timeout expires, then recheck the stop flag.
                //
                // Latency impact: zero for arriving events — poll(2) returns
                // immediately when the kernel has events ready on the fd.
                // Stop flag is honoured within ~50 ms of being set, so
                // GrabHandle::drop completes promptly even with no events.
                let mut pfd = libc::pollfd {
                    fd: dev.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                // SAFETY: valid pollfd; timeout 50 ms.
                unsafe { libc::poll(&mut pfd, 1, 50) };
                // Whether we got POLLIN, a timeout, or EINTR: recheck the stop
                // flag at the top of the loop, then call fetch_events if we have
                // data (WouldBlock handles the rare race between poll & read).
                if pfd.revents & libc::POLLIN == 0 {
                    continue; // timeout or EINTR — recheck stop flag
                }
            }

            let events = match dev.fetch_events() {
                Ok(evs) => evs,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    // O_NONBLOCK + empty queue (can happen even after poll reports
                    // POLLIN in some edge cases) — recheck stop flag and retry.
                    if !do_grab {
                        // For ungrabbed test devices, sleep briefly to avoid
                        // a busy spin when there truly are no events.
                        std::thread::sleep(std::time::Duration::from_millis(2));
                    }
                    continue;
                }
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
                    if tx.send(Msg::Input(ev, Some(source))).is_err() {
                        return; // engine thread gone; shut down
                    }
                } else if is_pointer && ev_type == evdev::EventType::RELATIVE {
                    match raw.code() {
                        REL_WHEEL | REL_HWHEEL => {
                            // Wheel goes through the engine so it can be remapped.
                            for ev in wheel_events(raw.code(), raw.value(), now_us()) {
                                if tx.send(Msg::Input(ev, Some(source))).is_err() {
                                    return;
                                }
                            }
                        }
                        // Hi-res wheel would double-scroll alongside the
                        // synthesized low-res ticks; libinput re-derives hi-res
                        // downstream.
                        REL_WHEEL_HI_RES | REL_HWHEEL_HI_RES => {}
                        _ => {
                            // Motion stays on the direct path — no channel hop.
                            if let Ok(mut o) = out.lock() {
                                let _ = o.emit_raw_mouse(&raw);
                            }
                        }
                    }
                } else if is_pointer && ev_type == evdev::EventType::MISC {
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

    fn dev(name: &str, class: DeviceClass) -> Discovered {
        Discovered {
            path: "/dev/input/event0".into(),
            name: name.into(),
            vendor: 0x046d,
            product: 0xc24a,
            phys: String::new(),
            class,
            keys: Vec::new(),
            wheel: false,
            hwheel: false,
        }
    }

    #[test]
    fn grab_rules_by_class_and_selector() {
        let s = conduit_core::config::compile(
            "[devices]\ngrab_all_keyboards = true\ngrab_mice = [\"046d:c24a\"]",
        )
        .unwrap()
        .settings;
        assert!(should_grab(&dev("Any Kbd", DeviceClass::Keyboard), &s));
        assert!(should_grab(&dev("G600", DeviceClass::Mouse), &s)); // vid:pid selector
        assert!(!should_grab(&dev("Consumer Ctl", DeviceClass::MediaKeys), &s));
        assert!(!should_grab(&dev("Pad", DeviceClass::Other), &s));
        assert!(!should_grab(&dev("Controller", DeviceClass::Gamepad), &s));
    }

    #[test]
    fn grab_keyboard_by_exact_name() {
        let s = conduit_core::config::compile(
            "[devices]\ngrab_all_keyboards = false\ngrab_keyboards = [\"My Keyboard\"]",
        )
        .unwrap()
        .settings;
        assert!(should_grab(&dev("My Keyboard", DeviceClass::Keyboard), &s));
        assert!(!should_grab(&dev("Other Keyboard", DeviceClass::Keyboard), &s));
    }

    #[test]
    fn grab_all_mice_excludes_touchpads() {
        let s = conduit_core::config::compile("[devices]\ngrab_all_mice = true")
            .unwrap()
            .settings;
        assert!(should_grab(&dev("G600", DeviceClass::Mouse), &s));
        assert!(!should_grab(&dev("Synaptics", DeviceClass::Touchpad), &s));
    }

    #[test]
    fn touchpad_grabbed_only_by_explicit_selector() {
        let s = conduit_core::config::compile(
            "[devices]\ngrab_all_mice = true\ngrab_mice = [\"Synaptics\"]",
        )
        .unwrap()
        .settings;
        assert!(should_grab(&dev("Synaptics", DeviceClass::Touchpad), &s));
    }

    #[test]
    fn conduit_virtual_devices_never_grabbed() {
        let s = conduit_core::config::compile(
            "[devices]\ngrab_all_keyboards = true\ngrab_all_mice = true",
        )
        .unwrap()
        .settings;
        assert!(!should_grab(&dev("Conduit Virtual Keyboard", DeviceClass::Keyboard), &s));
        assert!(!should_grab(&dev("Conduit Virtual Mouse", DeviceClass::Mouse), &s));
    }

    #[test]
    fn discovered_id_format() {
        assert_eq!(dev("G600", DeviceClass::Mouse).id(), "046d:c24a/G600");
    }

    // ── Wheel translation ──────────────────────────────────────────────────────

    #[test]
    fn wheel_events_translate_ticks() {
        use conduit_core::keys as ckeys;
        // REL_WHEEL +1 → wheelup press+release
        let evs = wheel_events(REL_WHEEL, 1, 42);
        assert_eq!(evs.len(), 2);
        assert_eq!(evs[0], Event { key: ckeys::WHEEL_UP, state: KeyState::Press, time_us: 42 });
        assert_eq!(evs[1], Event { key: ckeys::WHEEL_UP, state: KeyState::Release, time_us: 42 });
        // value -3 → three wheeldown pairs
        let evs = wheel_events(REL_WHEEL, -3, 0);
        assert_eq!(evs.len(), 6);
        assert!(evs.iter().all(|e| e.key == ckeys::WHEEL_DOWN));
        // HWHEEL: positive = right, negative = left
        assert_eq!(wheel_events(REL_HWHEEL, 1, 0)[0].key, ckeys::WHEEL_RIGHT);
        assert_eq!(wheel_events(REL_HWHEEL, -1, 0)[0].key, ckeys::WHEEL_LEFT);
        // zero and non-wheel codes → nothing
        assert!(wheel_events(REL_WHEEL, 0, 0).is_empty());
        assert!(wheel_events(0x00, 5, 0).is_empty()); // REL_X
        assert!(wheel_events(REL_WHEEL_HI_RES, 120, 0).is_empty());
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
