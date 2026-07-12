//! Hyprland focus backend.
//!
//! Connects to the Hyprland IPC event socket (`.socket2.sock`) and translates
//! `activewindow>>CLASS,TITLE` events into `Msg::Focus` messages.
//!
//! # Socket paths
//! - Event socket: `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket2.sock`
//! - Command socket: `$XDG_RUNTIME_DIR/hypr/$HYPRLAND_INSTANCE_SIGNATURE/.socket.sock`
//!
//! # Reconnect backoff
//! On socket error: sleep 1 s (doubling up to max 30 s), then reconnect.
//! Backoff resets on successful connect.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use crossbeam_channel::Sender;
use conduit_proto::FocusInfo;

use crate::runloop::Msg;
use super::FocusBackend;

// ── Backoff helper ─────────────────────────────────────────────────────────────

/// Double the current backoff, capped at 30 seconds.
pub fn next_backoff(cur: Duration) -> Duration {
    Duration::from_secs(cur.as_secs().saturating_mul(2).min(30))
}

// ── Pure parsing ───────────────────────────────────────────────────────────────

/// Parse a Hyprland event line.
///
/// Returns `Some((class, title))` for `activewindow>>CLASS,TITLE` events.
/// The split is on the **first comma only**, so titles that contain commas
/// are preserved.
/// Returns `None` for all other event types.
pub fn parse_event_line(line: &str) -> Option<(String, String)> {
    let data = line.strip_prefix("activewindow>>")?;
    // Split on the FIRST comma only — titles may contain commas.
    let comma = data.find(',')?;
    let class = data[..comma].to_string();
    let title = data[comma + 1..].to_string();
    Some((class, title))
}

// ── Socket helpers ─────────────────────────────────────────────────────────────

fn socket_dir() -> Option<PathBuf> {
    let sig = std::env::var("HYPRLAND_INSTANCE_SIGNATURE").ok()?;
    if sig.is_empty() {
        return None;
    }
    let runtime = std::env::var("XDG_RUNTIME_DIR").ok()?;
    Some(PathBuf::from(runtime).join("hypr").join(sig))
}

fn event_socket_path() -> Option<PathBuf> {
    Some(socket_dir()?.join(".socket2.sock"))
}

fn command_socket_path() -> Option<PathBuf> {
    Some(socket_dir()?.join(".socket.sock"))
}

/// Send a command to the Hyprland command socket and return the response bytes.
/// Returns `None` on any error.
fn hypr_command(cmd: &str) -> Option<String> {
    let path = command_socket_path()?;
    let mut stream = UnixStream::connect(&path).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    stream.write_all(cmd.as_bytes()).ok()?;
    let mut buf = String::new();
    stream.read_to_string(&mut buf).ok()?;
    Some(buf)
}

/// Query the command socket for the active window's PID, class, and title.
/// Returns `(pid, class, title)` on success.
fn query_active_window() -> Option<(u32, String, String)> {
    let json = hypr_command("j/activewindow")?;
    let val: serde_json::Value = serde_json::from_str(&json).ok()?;
    let pid = val["pid"].as_u64()? as u32;
    let class = val["class"].as_str().unwrap_or("").to_string();
    let title = val["title"].as_str().unwrap_or("").to_string();
    Some((pid, class, title))
}

/// Read process name from `/proc/<pid>/comm`, trimming whitespace.
fn read_comm(pid: u32) -> String {
    fs::read_to_string(format!("/proc/{}/comm", pid))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

// ── list_windows ───────────────────────────────────────────────────────────────

/// Query all Hyprland clients and return them as `FocusInfo` structs.
/// Returns an empty vec if Hyprland is not available.
/// Called by `focus::list_windows()` (Task 14 IPC).
#[allow(dead_code)]
pub fn list_windows() -> Vec<FocusInfo> {
    let json = match hypr_command("j/clients") {
        Some(j) => j,
        None => return Vec::new(),
    };
    let arr: Vec<serde_json::Value> = match serde_json::from_str(&json) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    arr.iter()
        .filter_map(|v| {
            let class = v["class"].as_str().unwrap_or("").to_string();
            let title = v["title"].as_str().unwrap_or("").to_string();
            let pid = v["pid"].as_u64().unwrap_or(0) as u32;
            let process = if pid > 0 { read_comm(pid) } else { String::new() };
            Some(FocusInfo { process, class, title })
        })
        .collect()
}

// ── Backend ────────────────────────────────────────────────────────────────────

/// Hyprland focus backend.  Connects to the event socket and streams
/// `activewindow` events to the run-loop channel.
pub struct HyprlandBackend {
    event_socket: PathBuf,
}

impl HyprlandBackend {
    /// Construct from the Hyprland environment variables.
    /// Returns `None` if `HYPRLAND_INSTANCE_SIGNATURE` is absent or empty.
    pub fn new() -> Option<Self> {
        let path = event_socket_path()?;
        Some(Self { event_socket: path })
    }
}

impl FocusBackend for HyprlandBackend {
    fn run(self: Box<Self>, tx: Sender<Msg>) {
        let mut backoff = Duration::from_secs(1);

        loop {
            match UnixStream::connect(&self.event_socket) {
                Err(e) => {
                    eprintln!(
                        "conduit/focus/hyprland: connect error: {}; retrying in {}s",
                        e,
                        backoff.as_secs()
                    );
                    std::thread::sleep(backoff);
                    backoff = next_backoff(backoff);
                }
                Ok(stream) => {
                    // Reset backoff on successful connect.
                    backoff = Duration::from_secs(1);
                    eprintln!("conduit/focus/hyprland: connected to event socket");

                    let reader = BufReader::new(stream);
                    let mut disconnected = false;
                    for line_result in reader.lines() {
                        match line_result {
                            Err(e) => {
                                eprintln!(
                                    "conduit/focus/hyprland: socket read error: {}",
                                    e
                                );
                                disconnected = true;
                                break;
                            }
                            Ok(line) => {
                                if let Some((class, title)) = parse_event_line(&line) {
                                    let (process, final_class, final_title) =
                                        match query_active_window() {
                                            Some((pid, c, t)) => (read_comm(pid), c, t),
                                            None => (String::new(), class, title),
                                        };
                                    let info = FocusInfo {
                                        process,
                                        class: final_class,
                                        title: final_title,
                                    };
                                    eprintln!(
                                        "conduit/focus/hyprland: focus → process={:?} class={:?} title={:?}",
                                        info.process, info.class, info.title
                                    );
                                    if tx.send(Msg::Focus(info)).is_err() {
                                        // Channel closed: daemon is shutting down.
                                        return;
                                    }
                                }
                            }
                        }
                    }
                    if !disconnected {
                        eprintln!("conduit/focus/hyprland: event socket EOF");
                    }
                    std::thread::sleep(backoff);
                    backoff = next_backoff(backoff);
                }
            }
        }
    }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── parse_event_line ──────────────────────────────────────────────────────

    #[test]
    fn parse_activewindow_basic() {
        let result = parse_event_line("activewindow>>kitty,my terminal");
        assert_eq!(result, Some(("kitty".to_string(), "my terminal".to_string())));
    }

    #[test]
    fn parse_activewindow_title_with_commas() {
        // Title "my , title" — the comma in the title must NOT split further.
        let result = parse_event_line("activewindow>>kitty,my , title");
        assert_eq!(result, Some(("kitty".to_string(), "my , title".to_string())));
    }

    #[test]
    fn parse_activewindow_empty_class_and_title() {
        // Hyprland emits "activewindow>>," when there is no active window.
        let result = parse_event_line("activewindow>>,");
        assert_eq!(result, Some(("".to_string(), "".to_string())));
    }

    #[test]
    fn parse_workspace_event_returns_none() {
        assert!(parse_event_line("workspace>>2").is_none());
    }

    #[test]
    fn parse_activewindowv2_returns_none() {
        assert!(parse_event_line("activewindowv2>>some-address").is_none());
    }

    #[test]
    fn parse_empty_line_returns_none() {
        assert!(parse_event_line("").is_none());
    }

    #[test]
    fn parse_other_events_return_none() {
        assert!(parse_event_line("focusedmon>>DP-1,default").is_none());
        assert!(parse_event_line("movewindow>>address,workspace").is_none());
        assert!(parse_event_line("fullscreen>>0").is_none());
    }

    // ── next_backoff ──────────────────────────────────────────────────────────

    #[test]
    fn backoff_doubles_up_to_30s() {
        let d1 = Duration::from_secs(1);
        let d2 = next_backoff(d1);
        assert_eq!(d2, Duration::from_secs(2));
        let d3 = next_backoff(d2);
        assert_eq!(d3, Duration::from_secs(4));
        let d4 = next_backoff(d3);
        assert_eq!(d4, Duration::from_secs(8));
        let d5 = next_backoff(d4);
        assert_eq!(d5, Duration::from_secs(16));
        let d6 = next_backoff(d5);
        assert_eq!(d6, Duration::from_secs(30)); // capped
        let d7 = next_backoff(d6);
        assert_eq!(d7, Duration::from_secs(30)); // stays at cap
    }

    // ── Live verification test (requires Hyprland) ─────────────────────────────

    /// Connect to the Hyprland command socket, call list_windows(), and query
    /// the current active window.  Run with:
    ///   cargo test -p conduit-daemon -- focus::hyprland::tests::live_hyprland_verification --ignored --nocapture
    #[test]
    #[ignore]
    fn live_hyprland_verification() {
        let sig = std::env::var("HYPRLAND_INSTANCE_SIGNATURE")
            .expect("HYPRLAND_INSTANCE_SIGNATURE must be set");
        assert!(!sig.is_empty(), "HYPRLAND_INSTANCE_SIGNATURE is empty");

        println!("Hyprland instance: {}", sig);

        // list_windows
        let windows = list_windows();
        println!("list_windows() returned {} windows:", windows.len());
        for w in &windows {
            println!(
                "  process={:?} class={:?} title={:?}",
                w.process, w.class, w.title
            );
        }

        // current active window
        match query_active_window() {
            Some((pid, class, title)) => {
                let process = read_comm(pid);
                println!(
                    "Active window: pid={} process={:?} class={:?} title={:?}",
                    pid, process, class, title
                );
            }
            None => println!("No active window or command socket unavailable"),
        }
    }
}
