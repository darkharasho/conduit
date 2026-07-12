//! X11 focus backend.
//!
//! Watches `_NET_ACTIVE_WINDOW` property changes on the root window and
//! translates them into `Msg::Focus` messages.
//!
//! # Properties read
//! - `WM_CLASS` (second null-separated string = class; first = instance)
//! - `_NET_WM_NAME` (UTF8_STRING) — falls back to `WM_NAME` (STRING)
//! - `_NET_WM_PID` (CARDINAL) → `/proc/<pid>/comm` for process name
//!
//! Missing properties produce empty strings; a BadWindow race (window closed
//! between the event and the property query) is silently skipped.
//!
//! # Reconnect backoff
//! On connection error: sleep 1 s (doubling up to max 30 s), then reconnect.

use std::fs;
use std::time::Duration;

use crossbeam_channel::Sender;
use conduit_proto::FocusInfo;
use x11rb::connection::Connection;
use x11rb::errors::ReplyError;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ChangeWindowAttributesAux, ConnectionExt, EventMask, Window,
};
use x11rb::protocol::Event as X11Event;
use x11rb::rust_connection::RustConnection;

use crate::runloop::Msg;
use super::FocusBackend;

// ── Backoff ────────────────────────────────────────────────────────────────────

fn next_backoff(cur: Duration) -> Duration {
    Duration::from_secs(cur.as_secs().saturating_mul(2).min(30))
}

// ── list_windows ───────────────────────────────────────────────────────────────

/// Walk `_NET_CLIENT_LIST` on the root window and return each window as a
/// `FocusInfo`.  Returns an empty vec if the connection fails or the property
/// is absent.
/// Called by `focus::list_windows()` (Task 14 IPC).
#[allow(dead_code)]
pub fn list_windows() -> Vec<FocusInfo> {
    let (conn, screen_num) = match x11rb::connect(None) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let screen = &conn.setup().roots[screen_num];
    let root = screen.root;

    // Intern atoms needed below.
    let atoms = match intern_atoms(&conn) {
        Ok(a) => a,
        Err(_) => return Vec::new(),
    };

    let cookie = match conn.get_property(
        false,
        root,
        atoms.net_client_list,
        AtomEnum::WINDOW,
        0,
        u32::MAX,
    ) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let reply = match cookie.reply() {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    let window_ids: Vec<Window> = reply
        .value32()
        .map(|iter| iter.collect())
        .unwrap_or_default();

    window_ids
        .iter()
        .filter_map(|&win| read_focus_info(&conn, win, &atoms).ok().flatten())
        .collect()
}

// ── Interned atoms ─────────────────────────────────────────────────────────────

#[allow(dead_code)]
struct Atoms {
    net_active_window: Atom,
    net_wm_name: Atom,
    net_wm_pid: Atom,
    /// Used by `list_windows()` (Task 14 IPC path).
    net_client_list: Atom,
    utf8_string: Atom,
    wm_name: Atom,
    wm_class: Atom,
}

/// Intern all atoms needed by the focus backend.
/// Uses `ReplyOrIdError` to encompass both connection and reply errors.
fn intern_atoms(conn: &RustConnection) -> Result<Atoms, x11rb::errors::ReplyOrIdError> {
    fn intern_one(
        conn: &RustConnection,
        name: &[u8],
    ) -> Result<Atom, x11rb::errors::ReplyOrIdError> {
        Ok(conn.intern_atom(false, name)?.reply()?.atom)
    }
    Ok(Atoms {
        net_active_window: intern_one(conn, b"_NET_ACTIVE_WINDOW")?,
        net_wm_name:       intern_one(conn, b"_NET_WM_NAME")?,
        net_wm_pid:        intern_one(conn, b"_NET_WM_PID")?,
        net_client_list:   intern_one(conn, b"_NET_CLIENT_LIST")?,
        utf8_string:       intern_one(conn, b"UTF8_STRING")?,
        wm_name:           intern_one(conn, b"WM_NAME")?,
        wm_class:          intern_one(conn, b"WM_CLASS")?,
    })
}

// ── Property helpers ───────────────────────────────────────────────────────────

/// Read the active window ID from `_NET_ACTIVE_WINDOW` on the root window.
fn get_active_window(
    conn: &RustConnection,
    root: Window,
    net_active_window: Atom,
) -> Option<Window> {
    let cookie = conn
        .get_property(false, root, net_active_window, AtomEnum::WINDOW, 0, 1)
        .ok()?;
    let reply = cookie.reply().ok()?;
    let val = reply.value32()?.next();
    val
}

/// Read `WM_CLASS` from a window.  Returns `(instance, class)` where `class`
/// is the second null-separated string.  Missing → empty strings.
///
/// Returns `Err` on a hard X error (e.g. BadWindow).
fn get_wm_class(
    conn: &RustConnection,
    win: Window,
    wm_class_atom: Atom,
) -> Result<(String, String), ReplyError> {
    let reply = conn
        .get_property(false, win, wm_class_atom, AtomEnum::STRING, 0, 512)?
        .reply()?;
    let bytes = reply.value;
    // WM_CLASS is two null-terminated strings concatenated.
    let mut parts = bytes.split(|&b| b == 0).filter(|s| !s.is_empty());
    let instance = parts
        .next()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default();
    let class = parts
        .next()
        .map(|b| String::from_utf8_lossy(b).into_owned())
        .unwrap_or_default();
    Ok((instance, class))
}

/// Read `_NET_WM_NAME` (UTF8_STRING).  Falls back to `WM_NAME` (STRING).
/// Returns empty string if neither is available.
///
/// Returns `Err` on a hard X error (e.g. BadWindow).
fn get_wm_name(
    conn: &RustConnection,
    win: Window,
    net_wm_name: Atom,
    utf8_string: Atom,
    wm_name: Atom,
) -> Result<String, ReplyError> {
    // Try _NET_WM_NAME first.
    let reply = conn
        .get_property(false, win, net_wm_name, utf8_string, 0, 1024)?
        .reply()?;
    if !reply.value.is_empty() {
        return Ok(String::from_utf8_lossy(&reply.value).into_owned());
    }
    // Fallback: WM_NAME (STRING)
    let reply = conn
        .get_property(false, win, wm_name, AtomEnum::STRING, 0, 1024)?
        .reply()?;
    Ok(String::from_utf8_lossy(&reply.value).into_owned())
}

/// Read `_NET_WM_PID` from a window. Returns `None` if absent.
///
/// Returns `Err` on a hard X error.
fn get_wm_pid(
    conn: &RustConnection,
    win: Window,
    net_wm_pid: Atom,
) -> Result<Option<u32>, ReplyError> {
    let reply = conn
        .get_property(false, win, net_wm_pid, AtomEnum::CARDINAL, 0, 1)?
        .reply()?;
    let pid = reply.value32().and_then(|mut it| it.next());
    Ok(pid)
}

/// Read process name from `/proc/<pid>/comm`, trimming whitespace.
fn read_comm(pid: u32) -> String {
    fs::read_to_string(format!("/proc/{}/comm", pid))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Read all focus properties for a window.  Returns `Ok(None)` if the window
/// has no usable properties (treated as a skip).  Returns `Err` on a hard X
/// error that should cause a reconnect (e.g. connection closed).
fn read_focus_info(
    conn: &RustConnection,
    win: Window,
    atoms: &Atoms,
) -> Result<Option<FocusInfo>, ReplyError> {
    // BadWindow manifests as a ReplyError::X11Error with error_kind == Window.
    // We catch it here and treat it as a skip (window closed race).
    let (_, class) = match get_wm_class(conn, win, atoms.wm_class) {
        Ok(pair) => pair,
        Err(e) if is_bad_window(&e) => return Ok(None),
        Err(e) => return Err(e),
    };
    let title = match get_wm_name(conn, win, atoms.net_wm_name, atoms.utf8_string, atoms.wm_name) {
        Ok(t) => t,
        Err(e) if is_bad_window(&e) => String::new(),
        Err(e) => return Err(e),
    };
    let pid = match get_wm_pid(conn, win, atoms.net_wm_pid) {
        Ok(p) => p,
        Err(e) if is_bad_window(&e) => None,
        Err(e) => return Err(e),
    };
    let process = pid.map(read_comm).unwrap_or_default();
    Ok(Some(FocusInfo { process, class, title }))
}

/// True if this ReplyError is a BadWindow X11 error.
fn is_bad_window(e: &ReplyError) -> bool {
    matches!(
        e,
        ReplyError::X11Error(ref xe)
            if xe.error_kind == x11rb::protocol::ErrorKind::Window
    )
}

// ── Backend ────────────────────────────────────────────────────────────────────

/// X11 focus backend.
pub struct X11Backend;

impl X11Backend {
    pub fn new() -> Self {
        Self
    }
}

impl FocusBackend for X11Backend {
    fn run(self: Box<Self>, tx: Sender<Msg>) {
        let mut backoff = Duration::from_secs(1);

        loop {
            match try_run_x11(&tx) {
                Ok(()) => {
                    // Returned cleanly — channel closed, daemon shutting down.
                    return;
                }
                Err(e) => {
                    eprintln!(
                        "conduit/focus/x11: error: {}; retrying in {}s",
                        e,
                        backoff.as_secs()
                    );
                    std::thread::sleep(backoff);
                    backoff = next_backoff(backoff);
                }
            }
        }
    }
}

/// Inner loop: connect, watch for property changes, send Focus messages.
/// Returns `Ok(())` if the channel closes (clean shutdown).
/// Returns `Err` on any X11 connection or protocol error.
fn try_run_x11(tx: &Sender<Msg>) -> Result<(), Box<dyn std::error::Error>> {
    let (conn, screen_num) = x11rb::connect(None)?;
    let screen = &conn.setup().roots[screen_num];
    let root = screen.root;

    // Intern atoms.
    let atoms = intern_atoms(&conn)
        .map_err(|e| format!("intern atoms: {}", e))?;

    // Select PropertyChange events on the root window.
    conn.change_window_attributes(
        root,
        &ChangeWindowAttributesAux::new().event_mask(EventMask::PROPERTY_CHANGE),
    )?
    .check()?;

    eprintln!("conduit/focus/x11: connected; watching _NET_ACTIVE_WINDOW");

    // Flush so the server starts sending events.
    conn.flush()?;

    loop {
        let event = conn.wait_for_event()?;
        match event {
            X11Event::PropertyNotify(ev) if ev.atom == atoms.net_active_window => {
                // Get active window id.
                let win = match get_active_window(&conn, root, atoms.net_active_window) {
                    Some(w) if w != 0 => w,
                    _ => continue,
                };
                match read_focus_info(&conn, win, &atoms) {
                    Ok(Some(info)) => {
                        eprintln!(
                            "conduit/focus/x11: focus → process={:?} class={:?} title={:?}",
                            info.process, info.class, info.title
                        );
                        if tx.send(Msg::Focus(info)).is_err() {
                            // Channel closed: daemon shutting down.
                            return Ok(());
                        }
                    }
                    Ok(None) => {
                        // BadWindow race — window closed before we queried; skip.
                    }
                    Err(e) => {
                        return Err(format!("property query error: {}", e).into());
                    }
                }
            }
            _ => {} // Ignore all other events.
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_sequence_matches_hyprland() {
        // Both backends use the same doubling-to-30s logic.
        let d1 = Duration::from_secs(1);
        let d2 = next_backoff(d1);
        assert_eq!(d2, Duration::from_secs(2));
        let d6 = next_backoff(next_backoff(next_backoff(next_backoff(d2))));
        assert_eq!(d6, Duration::from_secs(30));
    }

    /// Live verification: connect to X11, read the current active window, and
    /// call list_windows().  Run with:
    ///   cargo test -p conduit-daemon -- focus::x11::tests::live_x11_verification --ignored --nocapture
    #[test]
    #[ignore]
    fn live_x11_verification() {
        let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0".to_string());
        println!("DISPLAY={}", display);

        let windows = list_windows();
        println!("list_windows() returned {} windows:", windows.len());
        for w in &windows {
            println!(
                "  process={:?} class={:?} title={:?}",
                w.process, w.class, w.title
            );
        }

        // Also query the current active window directly.
        let (conn, screen_num) = x11rb::connect(None).expect("X11 connect");
        let screen = &conn.setup().roots[screen_num];
        let root = screen.root;
        let atoms = intern_atoms(&conn).expect("intern atoms");
        match get_active_window(&conn, root, atoms.net_active_window) {
            Some(win) if win != 0 => {
                match read_focus_info(&conn, win, &atoms) {
                    Ok(Some(info)) => println!(
                        "Active window: process={:?} class={:?} title={:?}",
                        info.process, info.class, info.title
                    ),
                    Ok(None) => println!("Active window: closed before query (BadWindow race)"),
                    Err(e) => println!("Active window query error: {}", e),
                }
            }
            _ => println!("No active window"),
        }
    }
}
