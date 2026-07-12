//! KDE Plasma (Wayland) focus backend.
//!
//! KWin ≥ 6 does not expose any window-management Wayland protocol to regular
//! clients (`org_kde_plasma_window_management`, `zwlr_foreign_toplevel_*` and
//! `ext_foreign_toplevel_list_v1` are all absent from the public registry),
//! so per-app focus tracking goes through the **KWin Scripting D-Bus API**
//! instead — the same mechanism `xremap` and `kdotool` use:
//!
//! 1. The daemon claims `org.conduit.Conduit` on the session bus and serves
//!    the `org.conduit.Focus` interface at `/org/conduit/Focus`.
//! 2. A small JavaScript file is written to `$XDG_RUNTIME_DIR/conduit/` and
//!    loaded into KWin via `org.kde.KWin /Scripting loadScript + run`.
//! 3. The script calls `NotifyActiveWindow(caption, resourceClass, pid)` on
//!    every window activation (and on title change of the active window, so
//!    `title` regex matchers stay live).
//! 4. If KWin restarts (`NameOwnerChanged` on `org.kde.KWin`), the script is
//!    re-injected.
//!
//! `list_windows()` follows the same pattern with a one-shot script and a
//! temporary `org.conduit.WinList` service, waiting ≤ 2 s for the callback.

use std::sync::mpsc;
use std::time::Duration;

use crossbeam_channel::Sender;
use conduit_proto::FocusInfo;
use zbus::blocking::{connection, fdo::DBusProxy, Connection, Proxy};

use super::{next_backoff, read_comm, FocusBackend};
use crate::runloop::Msg;

pub const SERVICE: &str = "org.conduit.Conduit";
const WINLIST_SERVICE: &str = "org.conduit.WinList";
const OBJ_PATH: &str = "/org/conduit/Focus";
const KWIN_SERVICE: &str = "org.kde.KWin";

// ── KWin script sources ────────────────────────────────────────────────────────

const FOCUS_SCRIPT: &str = r#"
// conduit-focus: push active-window changes to the Conduit daemon over D-Bus.
var SERVICE = "{{SERVICE}}";
var current = null;

function notify(w) {
    callDBus(SERVICE, "/org/conduit/Focus", "org.conduit.Focus", "NotifyActiveWindow",
        w ? String(w.caption || "") : "",
        w ? String(w.resourceClass || "") : "",
        w ? (w.pid || 0) : 0);
}

function onCaptionChanged() { notify(current); }

function activated(w) {
    if (current !== null) {
        try { current.captionChanged.disconnect(onCaptionChanged); } catch (e) {}
    }
    current = w;
    if (current !== null) {
        try { current.captionChanged.connect(onCaptionChanged); } catch (e) {}
    }
    notify(w);
}

if (workspace.windowActivated !== undefined) {
    workspace.windowActivated.connect(activated);   // Plasma 6
    activated(workspace.activeWindow);
} else {
    workspace.clientActivated.connect(activated);   // Plasma 5
    activated(workspace.activeClient);
}
"#;

const WINLIST_SCRIPT: &str = r#"
// conduit-winlist: one-shot dump of the window list, then unloaded by the daemon.
var SERVICE = "{{SERVICE}}";
var list = (workspace.windowList !== undefined) ? workspace.windowList() : workspace.clientList();
var out = [];
for (var i = 0; i < list.length; ++i) {
    var w = list[i];
    if (w.normalWindow === false) continue;
    out.push({ title: String(w.caption || ""), class: String(w.resourceClass || ""), pid: w.pid || 0 });
}
callDBus(SERVICE, "/org/conduit/Focus", "org.conduit.Focus", "NotifyWindowList", JSON.stringify(out));
"#;

// ── D-Bus interface served to KWin scripts ─────────────────────────────────────

struct FocusIface {
    /// Persistent backend: forwards activations to the engine.
    focus_tx: Option<Sender<Msg>>,
    /// One-shot `list_windows` reply channel.
    winlist_tx: Option<mpsc::Sender<Vec<FocusInfo>>>,
}

#[zbus::interface(name = "org.conduit.Focus")]
impl FocusIface {
    fn notify_active_window(&self, caption: String, resource_class: String, pid: i32) {
        if let Some(tx) = &self.focus_tx {
            let process = if pid > 0 { read_comm(pid as u32) } else { String::new() };
            let info = FocusInfo { process, class: resource_class, title: caption };
            eprintln!(
                "conduit/focus/kde: focus → process={:?} class={:?} title={:?}",
                info.process, info.class, info.title
            );
            let _ = tx.send(Msg::Focus(info));
        }
    }

    fn notify_window_list(&self, json: String) {
        if let Some(tx) = &self.winlist_tx {
            let _ = tx.send(parse_window_list(&json));
        }
    }
}

/// Parse the JSON array produced by `WINLIST_SCRIPT`. Malformed input → empty.
pub fn parse_window_list(json: &str) -> Vec<FocusInfo> {
    let Ok(vals) = serde_json::from_str::<Vec<serde_json::Value>>(json) else {
        return Vec::new();
    };
    vals.iter()
        .map(|v| {
            let pid = v["pid"].as_u64().unwrap_or(0) as u32;
            FocusInfo {
                process: if pid > 0 { read_comm(pid) } else { String::new() },
                class: v["class"].as_str().unwrap_or("").to_string(),
                title: v["title"].as_str().unwrap_or("").to_string(),
            }
        })
        .collect()
}

// ── KWin scripting helpers ─────────────────────────────────────────────────────

/// True when KWin is reachable on the session bus.
pub fn available() -> bool {
    let Ok(conn) = Connection::session() else { return false };
    let Ok(dbus) = DBusProxy::new(&conn) else { return false };
    let Ok(name) = KWIN_SERVICE.try_into() else { return false };
    dbus.name_has_owner(name).unwrap_or(false)
}

fn script_dir() -> std::path::PathBuf {
    let base = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
    std::path::PathBuf::from(base).join("conduit")
}

/// `unloadScript` (idempotent) → `loadScript` → `run`. Returns the script id.
fn load_kwin_script(conn: &Connection, path: &str, plugin: &str) -> anyhow::Result<i32> {
    let scripting = Proxy::new(conn, KWIN_SERVICE, "/Scripting", "org.kde.kwin.Scripting")?;
    let _ = scripting.call_method("unloadScript", &(plugin,)); // ok if not loaded
    let id: i32 = scripting.call("loadScript", &(path, plugin))?;
    anyhow::ensure!(id >= 0, "KWin loadScript returned {id}");
    // Plasma ≥ 5.24 exposes /Scripting/ScriptN; older releases exposed /N.
    for obj in [format!("/Scripting/Script{id}"), format!("/{id}")] {
        if let Ok(script) = Proxy::new(conn, KWIN_SERVICE, obj.as_str(), "org.kde.kwin.Script") {
            if script.call_method("run", &()).is_ok() {
                return Ok(id);
            }
        }
    }
    anyhow::bail!("could not run KWin script {id}")
}

fn unload_kwin_script(conn: &Connection, plugin: &str) {
    if let Ok(scripting) = Proxy::new(conn, KWIN_SERVICE, "/Scripting", "org.kde.kwin.Scripting") {
        let _ = scripting.call_method("unloadScript", &(plugin,));
    }
}

// ── Backend ────────────────────────────────────────────────────────────────────

pub struct KdeBackend;

impl KdeBackend {
    /// Available only when KWin is reachable on the session bus.
    pub fn new() -> Option<Self> {
        available().then_some(KdeBackend)
    }
}

impl FocusBackend for KdeBackend {
    fn run(self: Box<Self>, tx: Sender<Msg>) {
        let mut backoff = Duration::from_secs(1);
        loop {
            match run_once(&tx) {
                Ok(()) => return,
                Err(e) => {
                    eprintln!("conduit/focus/kde: {e}; retrying in {}s", backoff.as_secs());
                    std::thread::sleep(backoff);
                    backoff = next_backoff(backoff);
                }
            }
        }
    }
}

/// Claim the service, serve the interface, inject the script, then block on
/// `NameOwnerChanged` to re-inject whenever KWin restarts.
fn run_once(tx: &Sender<Msg>) -> anyhow::Result<()> {
    let iface = FocusIface { focus_tx: Some(tx.clone()), winlist_tx: None };
    let conn = connection::Builder::session()?
        .name(SERVICE)?
        .serve_at(OBJ_PATH, iface)?
        .build()?;

    let dir = script_dir();
    std::fs::create_dir_all(&dir)?;
    let script_path = dir.join("kwin-focus.js");
    std::fs::write(&script_path, FOCUS_SCRIPT.replace("{{SERVICE}}", SERVICE))?;
    load_kwin_script(&conn, &script_path.to_string_lossy(), "conduit-focus")?;
    eprintln!("conduit/focus/kde: KWin script loaded");

    let dbus = DBusProxy::new(&conn)?;
    let changed = dbus.receive_name_owner_changed()?;
    for signal in changed {
        let args = signal.args()?;
        if args.name().as_str() == KWIN_SERVICE && args.new_owner().is_some() {
            eprintln!("conduit/focus/kde: KWin restarted; re-injecting script");
            load_kwin_script(&conn, &script_path.to_string_lossy(), "conduit-focus")?;
        }
    }
    anyhow::bail!("D-Bus signal stream ended")
}

// ── list_windows ───────────────────────────────────────────────────────────────

/// One-shot window list. Errors (KWin gone, timeout, name collision from a
/// concurrent request) degrade to an empty list with a log line.
pub fn list_windows() -> Vec<FocusInfo> {
    match list_windows_inner() {
        Ok(w) => w,
        Err(e) => {
            eprintln!("conduit/focus/kde: list_windows: {e}");
            Vec::new()
        }
    }
}

fn list_windows_inner() -> anyhow::Result<Vec<FocusInfo>> {
    let (reply_tx, reply_rx) = mpsc::channel();
    let iface = FocusIface { focus_tx: None, winlist_tx: Some(reply_tx) };
    let conn = connection::Builder::session()?
        .name(WINLIST_SERVICE)?
        .serve_at(OBJ_PATH, iface)?
        .build()?;

    let dir = script_dir();
    std::fs::create_dir_all(&dir)?;
    let script_path = dir.join("kwin-winlist.js");
    std::fs::write(&script_path, WINLIST_SCRIPT.replace("{{SERVICE}}", WINLIST_SERVICE))?;
    load_kwin_script(&conn, &script_path.to_string_lossy(), "conduit-winlist")?;

    let result = reply_rx.recv_timeout(Duration::from_secs(2));
    unload_kwin_script(&conn, "conduit-winlist");
    Ok(result.unwrap_or_default())
}

// ── Tests ──────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scripts_reference_the_dbus_interface() {
        for s in [FOCUS_SCRIPT, WINLIST_SCRIPT] {
            assert!(s.contains("callDBus"));
            assert!(s.contains("org.conduit.Focus"));
            assert!(s.contains("{{SERVICE}}"));
        }
        assert!(FOCUS_SCRIPT.contains("windowActivated")); // Plasma 6
        assert!(FOCUS_SCRIPT.contains("clientActivated")); // Plasma 5 fallback
        assert!(FOCUS_SCRIPT.contains("captionChanged")); // live title tracking
        assert!(WINLIST_SCRIPT.contains("windowList"));
    }

    #[test]
    fn parse_window_list_happy_and_malformed() {
        let wins = parse_window_list(r#"[{"title":"T","class":"firefox","pid":0}]"#);
        assert_eq!(wins.len(), 1);
        assert_eq!(wins[0].class, "firefox");
        assert_eq!(wins[0].title, "T");
        assert!(wins[0].process.is_empty());
        assert!(parse_window_list("not json").is_empty());
        assert!(parse_window_list("{}").is_empty());
    }

    /// Live check of the persistent focus stream: claims the real service,
    /// injects the focus script, and expects the initial active-window
    /// callback within 5 s. Run manually (daemon must not be running):
    ///   cargo test -p conduit-daemon -- focus::kde::tests::live_kde_focus_stream --ignored --nocapture
    #[test]
    #[ignore]
    fn live_kde_focus_stream() {
        assert!(available(), "KWin not reachable on the session bus");
        let (tx, rx) = crossbeam_channel::unbounded();
        std::thread::spawn(move || {
            let _ = run_once(&tx);
        });
        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Msg::Focus(f)) => {
                println!(
                    "initial focus: process={:?} class={:?} title={:?}",
                    f.process, f.class, f.title
                );
                assert!(!f.class.is_empty() || !f.title.is_empty());
            }
            _ => panic!("no focus callback from KWin within 5s"),
        }
        // Cleanup so a subsequently started daemon owns the script slot.
        if let Ok(conn) = Connection::session() {
            unload_kwin_script(&conn, "conduit-focus");
        }
    }

    /// Live end-to-end check against the real KWin. Run manually:
    ///   cargo test -p conduit-daemon -- focus::kde::tests::live_kde_verification --ignored --nocapture
    #[test]
    #[ignore]
    fn live_kde_verification() {
        assert!(available(), "KWin not reachable on the session bus");
        let wins = list_windows();
        println!("list_windows() returned {} windows:", wins.len());
        for w in &wins {
            println!("  process={:?} class={:?} title={:?}", w.process, w.class, w.title);
        }
        assert!(!wins.is_empty(), "expected at least one window on a live desktop");
    }
}
