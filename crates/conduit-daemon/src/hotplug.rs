//! udev hotplug monitor: sends `Msg::DeviceAdded` / `Msg::DeviceRemoved`
//! when input devices appear or disappear under `/dev/input/`.
//!
//! # Threading model
//! `spawn` returns immediately; the monitor runs on a dedicated thread that
//! loops with a 200 ms sleep between drains of the non-blocking udev socket.
//! This keeps the implementation dependency-light (no mio needed).
//!
//! # Permission timing
//! After an `add` event the thread sleeps 100 ms before sending
//! `Msg::DeviceAdded`; udev may not have applied group permissions yet, and
//! `devices::probe` (called in the run loop) opens the device.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crossbeam_channel::Sender;

use crate::runloop::Msg;

// ── Pure helpers (unit-testable) ──────────────────────────────────────────────

/// Returns `true` if `path` is an input event node: `/dev/input/event<digits>`.
///
/// Accepts `/dev/input/event0`, `/dev/input/event7`, `/dev/input/event12`.
/// Rejects `/dev/input/mouse0`, `/dev/input/js0`, `/dev/input/event7abc`.
pub fn is_event_node(path: &Path) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    if parent != Path::new("/dev/input") {
        return false;
    }
    let Some(fname) = path.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let Some(suffix) = fname.strip_prefix("event") else {
        return false;
    };
    !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit())
}

// ── Reader registry bookkeeping (unit-testable) ───────────────────────────────

/// Tracks which device paths currently have active readers.
///
/// This is a thin wrapper around a `Vec<PathBuf>` with set semantics that
/// lives inside the run loop.  The run loop owns the actual `GrabHandle`s in a
/// separate `HashMap`; this registry is consulted before inserting to prevent
/// double-grab.
///
/// Exposed as `pub` for unit tests; the production code uses `HashMap<PathBuf,
/// GrabHandle>` directly for combined bookkeeping.
#[allow(dead_code)]
pub struct ReaderRegistry {
    paths: Vec<PathBuf>,
}

#[allow(dead_code)]
impl ReaderRegistry {
    pub fn new() -> Self {
        Self { paths: Vec::new() }
    }

    /// Insert `path` if not already present. Returns `true` if newly inserted.
    pub fn add(&mut self, path: PathBuf) -> bool {
        if self.paths.contains(&path) {
            return false;
        }
        self.paths.push(path);
        true
    }

    /// Remove `path`. Returns `true` if it was present.
    pub fn remove(&mut self, path: &Path) -> bool {
        let before = self.paths.len();
        self.paths.retain(|p| p != path);
        self.paths.len() < before
    }

    pub fn contains(&self, path: &Path) -> bool {
        self.paths.iter().any(|p| p == path)
    }
}

// ── Hotplug monitor thread ────────────────────────────────────────────────────

/// Spawn the udev hotplug monitor thread.
///
/// The thread holds a clone of `tx`, which keeps the run loop alive even
/// when no physical devices are currently grabbed.  It exits only when the
/// run loop closes the channel (i.e. the daemon is shutting down).
pub fn spawn(tx: Sender<Msg>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let monitor = match build_monitor() {
            Ok(m) => m,
            Err(e) => {
                eprintln!("conduit: hotplug monitor failed to start: {e}");
                return;
            }
        };

        loop {
            // Drain all pending events without blocking.
            let mut disconnected = false;
            for event in monitor.iter() {
                if !handle_event(event, &tx) {
                    disconnected = true;
                    break;
                }
            }
            if disconnected {
                break;
            }

            // Sleep a short interval then drain again.  200 ms gives low
            // latency for hotplug without spinning the CPU.
            std::thread::sleep(Duration::from_millis(200));
        }
    })
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn build_monitor() -> anyhow::Result<udev::MonitorSocket> {
    let monitor = udev::MonitorBuilder::new()?
        .match_subsystem("input")?
        .listen()?;
    Ok(monitor)
}

/// Process one udev event.  Returns `true` if the channel is still alive,
/// `false` if the run loop has disconnected (daemon shutting down).
fn handle_event(event: udev::Event, tx: &Sender<Msg>) -> bool {
    // We only care about events that have a device node.
    let Some(node) = event.devnode() else {
        return true;
    };
    let path: PathBuf = node.to_path_buf();

    if !is_event_node(&path) {
        return true;
    }

    match event.event_type() {
        udev::EventType::Add => {
            // Sleep 100 ms: udev may not have applied group/mode yet.
            std::thread::sleep(Duration::from_millis(100));
            tx.send(Msg::DeviceAdded(path)).is_ok()
        }
        udev::EventType::Remove => {
            tx.send(Msg::DeviceRemoved(path)).is_ok()
        }
        _ => true,
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_event_node ──────────────────────────────────────────────────────────

    #[test]
    fn event_node_accepts_valid_paths() {
        assert!(is_event_node(Path::new("/dev/input/event0")));
        assert!(is_event_node(Path::new("/dev/input/event7")));
        assert!(is_event_node(Path::new("/dev/input/event12")));
        assert!(is_event_node(Path::new("/dev/input/event99")));
    }

    #[test]
    fn event_node_rejects_non_event_devices() {
        // Wrong device type
        assert!(!is_event_node(Path::new("/dev/input/mouse0")));
        assert!(!is_event_node(Path::new("/dev/input/js0")));
        // Trailing non-digits
        assert!(!is_event_node(Path::new("/dev/input/event7abc")));
        assert!(!is_event_node(Path::new("/dev/input/eventX")));
        // Wrong directory
        assert!(!is_event_node(Path::new("/dev/event0")));
        assert!(!is_event_node(Path::new("/dev/input/")));
        // Bare "event" with no digits
        assert!(!is_event_node(Path::new("/dev/input/event")));
    }

    // ── ReaderRegistry ─────────────────────────────────────────────────────────

    #[test]
    fn registry_add_returns_true_first_time() {
        let mut reg = ReaderRegistry::new();
        let p = PathBuf::from("/dev/input/event0");
        assert!(reg.add(p.clone()));
    }

    #[test]
    fn registry_add_returns_false_if_already_present() {
        let mut reg = ReaderRegistry::new();
        let p = PathBuf::from("/dev/input/event0");
        reg.add(p.clone());
        // Second add of the same path must not double-insert.
        assert!(!reg.add(p.clone()));
    }

    #[test]
    fn registry_contains_reflects_presence() {
        let mut reg = ReaderRegistry::new();
        let p = PathBuf::from("/dev/input/event3");
        assert!(!reg.contains(&p));
        reg.add(p.clone());
        assert!(reg.contains(&p));
    }

    #[test]
    fn registry_remove_clears_path() {
        let mut reg = ReaderRegistry::new();
        let p = PathBuf::from("/dev/input/event5");
        reg.add(p.clone());
        assert!(reg.remove(&p));
        assert!(!reg.contains(&p));
    }

    #[test]
    fn registry_remove_absent_path_returns_false() {
        let mut reg = ReaderRegistry::new();
        assert!(!reg.remove(Path::new("/dev/input/event9")));
    }

    #[test]
    fn registry_add_remove_independent_paths() {
        let mut reg = ReaderRegistry::new();
        let a = PathBuf::from("/dev/input/event0");
        let b = PathBuf::from("/dev/input/event1");
        reg.add(a.clone());
        reg.add(b.clone());
        reg.remove(&a);
        assert!(!reg.contains(&a));
        assert!(reg.contains(&b));
    }
}
