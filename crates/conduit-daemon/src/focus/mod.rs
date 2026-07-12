//! Focus watcher: detect the active application window and send
//! `Msg::Focus(FocusInfo)` to the run-loop engine.
//!
//! # Backend selection (in priority order)
//! 1. **Hyprland** — if `HYPRLAND_INSTANCE_SIGNATURE` is set and non-empty.
//! 2. **KDE (KWin)** — if `WAYLAND_DISPLAY` is set and `org.kde.KWin` is
//!    reachable on the session bus (KWin scripting; covers Plasma Wayland).
//! 3. **X11** — if `DISPLAY` is set and non-empty (includes Plasma on X11).
//! 4. **None** — log a warning; per-app profiles will use the default profile.

pub mod hyprland;
pub mod kde;
pub mod x11;

use std::time::Duration;

use crossbeam_channel::Sender;
use conduit_proto::FocusInfo;

use crate::runloop::Msg;

// ── Trait ──────────────────────────────────────────────────────────────────────

/// A focus backend runs in its own thread and sends `Msg::Focus` to the
/// engine whenever the focused window changes.  The implementation owns its
/// reconnect loop; `run` blocks until the channel closes (daemon shutdown).
pub trait FocusBackend: Send {
    fn run(self: Box<Self>, tx: Sender<Msg>);
}

// ── Shared helpers ─────────────────────────────────────────────────────────────

/// Double the current backoff, capped at 30 seconds.
pub fn next_backoff(cur: Duration) -> Duration {
    Duration::from_secs(cur.as_secs().saturating_mul(2).min(30))
}

/// Read process name from `/proc/<pid>/comm`, trimming whitespace.
pub(crate) fn read_comm(pid: u32) -> String {
    std::fs::read_to_string(format!("/proc/{}/comm", pid))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

// ── Backend selection ──────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum BackendKind {
    Hyprland,
    Kde,
    X11,
    None,
}

/// Pure priority decision (unit-testable): Hyprland → KDE (Wayland session
/// with KWin on the bus) → X11 → none.
pub fn select_backend(
    hypr_sig: &str,
    wayland_display: &str,
    kwin_available: bool,
    display: &str,
) -> BackendKind {
    if !hypr_sig.is_empty() {
        return BackendKind::Hyprland;
    }
    if !wayland_display.is_empty() && kwin_available {
        return BackendKind::Kde;
    }
    if !display.is_empty() {
        return BackendKind::X11;
    }
    BackendKind::None
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default()
}

/// Evaluate `select_backend` against the live environment. `kde::available()`
/// (a D-Bus round trip) is only consulted when a Wayland display is present
/// and Hyprland did not already win.
fn current_backend() -> BackendKind {
    let hypr_sig = env("HYPRLAND_INSTANCE_SIGNATURE");
    let wayland = env("WAYLAND_DISPLAY");
    let kwin = hypr_sig.is_empty() && !wayland.is_empty() && kde::available();
    select_backend(&hypr_sig, &wayland, kwin, &env("DISPLAY"))
}

// ── detect ─────────────────────────────────────────────────────────────────────

/// Detect which focus backend is available and return it.
pub fn detect() -> Option<Box<dyn FocusBackend>> {
    match current_backend() {
        BackendKind::Hyprland => match hyprland::HyprlandBackend::new() {
            Some(b) => {
                eprintln!(
                    "conduit/focus: using Hyprland backend (instance: {})",
                    env("HYPRLAND_INSTANCE_SIGNATURE")
                );
                Some(Box::new(b))
            }
            None => {
                eprintln!(
                    "conduit/focus: HYPRLAND_INSTANCE_SIGNATURE set but socket path unavailable"
                );
                None
            }
        },
        BackendKind::Kde => match kde::KdeBackend::new() {
            Some(b) => {
                eprintln!("conduit/focus: using KDE (KWin scripting) backend");
                Some(Box::new(b))
            }
            None => {
                eprintln!("conduit/focus: KWin vanished between detection and start");
                None
            }
        },
        BackendKind::X11 => {
            eprintln!("conduit/focus: using X11 backend (DISPLAY={})", env("DISPLAY"));
            Some(Box::new(x11::X11Backend::new()))
        }
        BackendKind::None => {
            eprintln!(
                "conduit/focus: WARNING — no display environment detected; \
                 per-app profiles disabled, default profile only"
            );
            None
        }
    }
}

// ── list_windows ───────────────────────────────────────────────────────────────

/// Return the list of currently open windows for the active environment.
///
/// - Hyprland: queries `j/clients` on the command socket.
/// - KDE: one-shot KWin script dumping `workspace.windowList()`.
/// - X11: walks `_NET_CLIENT_LIST` on the root window.
/// - Neither: returns an empty vec.
pub fn list_windows() -> Vec<FocusInfo> {
    match current_backend() {
        BackendKind::Hyprland => hyprland::list_windows(),
        BackendKind::Kde => kde::list_windows(),
        BackendKind::X11 => x11::list_windows(),
        BackendKind::None => Vec::new(),
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backend_priority() {
        use BackendKind::*;
        assert_eq!(select_backend("sig", "wayland-0", true, ":0"), Hyprland);
        assert_eq!(select_backend("", "wayland-0", true, ":0"), Kde);
        assert_eq!(select_backend("", "wayland-0", false, ":0"), X11); // Wayland w/o KWin → X11 fallback
        assert_eq!(select_backend("", "", true, ":0"), X11); // KDE on X11 stays X11
        assert_eq!(select_backend("", "", false, ""), None);
    }

    #[test]
    fn backoff_doubles_up_to_30s() {
        let mut d = Duration::from_secs(1);
        for expect in [2, 4, 8, 16, 30, 30] {
            d = next_backoff(d);
            assert_eq!(d, Duration::from_secs(expect));
        }
    }
}
