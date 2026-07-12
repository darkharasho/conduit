//! Focus watcher: detect the active application window and send
//! `Msg::Focus(FocusInfo)` to the run-loop engine.
//!
//! # Backend selection (in priority order)
//! 1. **Hyprland** — if `HYPRLAND_INSTANCE_SIGNATURE` is set and non-empty.
//! 2. **X11** — if `DISPLAY` is set and non-empty.
//! 3. **None** — log a warning; per-app profiles will use the default profile.

pub mod hyprland;
pub mod x11;

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

// ── detect ─────────────────────────────────────────────────────────────────────

/// Detect which focus backend is available and return it.
///
/// Priority:
/// 1. Hyprland (`HYPRLAND_INSTANCE_SIGNATURE` set and non-empty)
/// 2. X11 (`DISPLAY` set and non-empty)
/// 3. None (warning logged)
pub fn detect() -> Option<Box<dyn FocusBackend>> {
    // Hyprland takes priority.
    let hypr_sig = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").unwrap_or_default();
    if !hypr_sig.is_empty() {
        match hyprland::HyprlandBackend::new() {
            Some(b) => {
                eprintln!("conduit/focus: using Hyprland backend (instance: {})", hypr_sig);
                return Some(Box::new(b));
            }
            None => {
                eprintln!(
                    "conduit/focus: HYPRLAND_INSTANCE_SIGNATURE set but socket path unavailable"
                );
            }
        }
    }

    // X11 fallback.
    let display = std::env::var("DISPLAY").unwrap_or_default();
    if !display.is_empty() {
        eprintln!("conduit/focus: using X11 backend (DISPLAY={})", display);
        return Some(Box::new(x11::X11Backend::new()));
    }

    eprintln!(
        "conduit/focus: WARNING — no display environment detected; \
         per-app profiles disabled, default profile only"
    );
    None
}

// ── list_windows ───────────────────────────────────────────────────────────────

/// Return the list of currently open windows for the active environment.
///
/// - Hyprland: queries `j/clients` on the command socket.
/// - X11: walks `_NET_CLIENT_LIST` on the root window.
/// - Neither: returns an empty vec.
///
/// Called by the IPC layer (Task 14) to handle `Request::ListWindows`.
#[allow(dead_code)]
pub fn list_windows() -> Vec<FocusInfo> {
    let hypr_sig = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").unwrap_or_default();
    if !hypr_sig.is_empty() {
        return hyprland::list_windows();
    }

    let display = std::env::var("DISPLAY").unwrap_or_default();
    if !display.is_empty() {
        return x11::list_windows();
    }

    Vec::new()
}
