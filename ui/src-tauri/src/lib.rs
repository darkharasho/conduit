use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use conduit_proto::{Push, Request, Response};
use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};

mod apps;
mod ratbag;
mod setup;

// ---- Re-export proto types as Tauri-serializable types ----
// (conduit_proto already derives Serialize/Deserialize)

// ---- Error payload ----

#[derive(Debug, Clone, serde::Serialize)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    pub detail: String,
}

impl ErrorPayload {
    fn new(code: &str, message: impl Into<String>, detail: impl Into<String>) -> Self {
        ErrorPayload { code: code.into(), message: message.into(), detail: detail.into() }
    }

    fn from_io(context: &str, e: &std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound => {
                "engine-not-running"
            }
            std::io::ErrorKind::PermissionDenied => "permission-denied",
            _ => "internal",
        };
        ErrorPayload::new(code, context, e.to_string())
    }
}

impl From<conduit_proto::Response> for ErrorPayload {
    fn from(resp: conduit_proto::Response) -> Self {
        match resp {
            conduit_proto::Response::Err { code, message, detail, .. } => {
                ErrorPayload::new(code.as_str(), message, detail)
            }
            other => ErrorPayload::new(
                "internal",
                "unexpected response",
                format!("{other:?}"),
            ),
        }
    }
}

// ---- Helpers ----

/// Resolve the socket path from env or XDG default.
fn socket_path() -> PathBuf {
    if let Ok(p) = std::env::var("CONDUIT_SOCKET") {
        return PathBuf::from(p);
    }
    let runtime_dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| {
        format!("/run/user/{}", nix_uid())
    });
    PathBuf::from(runtime_dir).join("conduit.sock")
}

fn nix_uid() -> u32 {
    // Safe: just reads the real UID.
    unsafe { libc::getuid() }
}

/// Open a UnixStream to the daemon, send one Request, read one Response.
fn one_shot(req: &Request) -> Result<Response, ErrorPayload> {
    let path = socket_path();
    let mut stream = UnixStream::connect(&path)
        .map_err(|e| ErrorPayload::from_io("connecting to Conduit's engine", &e))?;
    let line = serde_json::to_string(req)
        .map_err(|e| ErrorPayload::new("internal", "failed to serialize request", e.to_string()))?;
    stream
        .write_all(line.as_bytes())
        .and_then(|_| stream.write_all(b"\n"))
        .map_err(|e| ErrorPayload::new("internal", "failed to write to socket", e.to_string()))?;
    let mut reader = BufReader::new(&stream);
    let mut resp_line = String::new();
    reader
        .read_line(&mut resp_line)
        .map_err(|e| ErrorPayload::new("internal", "failed to read from socket", e.to_string()))?;
    serde_json::from_str::<Response>(resp_line.trim())
        .map_err(|e| ErrorPayload::new("internal", "failed to parse response", e.to_string()))
}

/// Extract an Err response into a Tauri command error.
fn check_ok(resp: Response) -> Result<(), ErrorPayload> {
    match resp {
        Response::Ok => Ok(()),
        other => Err(ErrorPayload::from(other)),
    }
}

// ---- Tauri commands ----

#[tauri::command]
async fn get_status() -> Result<conduit_proto::Status, ErrorPayload> {
    match one_shot(&Request::GetStatus)? {
        Response::Status(s) => Ok(s),
        other => Err(ErrorPayload::from(other)),
    }
}

#[tauri::command]
async fn get_config() -> Result<String, ErrorPayload> {
    match one_shot(&Request::GetConfig)? {
        Response::Config { toml } => Ok(toml),
        other => Err(ErrorPayload::from(other)),
    }
}

#[tauri::command]
async fn set_config(toml: String) -> Result<u64, ErrorPayload> {
    match one_shot(&Request::SetConfig { toml })? {
        Response::ConfigApplied { version } => Ok(version),
        Response::Ok => Ok(0), // pre-versioning daemon
        other => Err(ErrorPayload::from(other)),
    }
}

#[tauri::command]
async fn list_devices() -> Result<Vec<conduit_proto::DeviceInfo>, ErrorPayload> {
    match one_shot(&Request::ListDevices)? {
        Response::Devices { devices } => Ok(devices),
        other => Err(ErrorPayload::from(other)),
    }
}

#[tauri::command]
async fn list_windows() -> Result<Vec<conduit_proto::FocusInfo>, ErrorPayload> {
    match one_shot(&Request::ListWindows)? {
        Response::Windows { windows } => Ok(windows),
        other => Err(ErrorPayload::from(other)),
    }
}

#[tauri::command]
async fn suspend() -> Result<(), ErrorPayload> {
    let resp = one_shot(&Request::Suspend)?;
    check_ok(resp)
}

#[tauri::command]
async fn resume() -> Result<(), ErrorPayload> {
    let resp = one_shot(&Request::Resume)?;
    check_ok(resp)
}

#[tauri::command]
async fn capture_next_key() -> Result<CapturedKey, ErrorPayload> {
    match one_shot(&Request::CaptureNextKey)? {
        Response::CapturedKey { name, code } => Ok(CapturedKey { name, code }),
        other => Err(ErrorPayload::from(other)),
    }
}

/// Find the `conduit-daemon` binary. Tries:
/// 1. `which conduit-daemon` (PATH)
/// 2. `~/.local/bin/conduit-daemon`
/// 3. `../target/debug/conduit-daemon` relative to the app executable
/// 4. `../target/release/conduit-daemon` relative to the app executable
pub(crate) fn find_conduit_daemon_binary() -> Option<std::path::PathBuf> {
    // 0. Bundled sidecar next to the running app executable. This is how the
    // AppImage ships conduit-daemon (Tauri `externalBin`), so it takes
    // priority over anything else on the system — an AppImage always runs
    // the daemon it was built and tested with.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let sidecar = setup::sidecar_candidate(exe_dir);
            if sidecar.exists() {
                return Some(sidecar);
            }
        }
    }

    // 1. PATH via `which`
    if let Ok(output) = std::process::Command::new("which").arg("conduit-daemon").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout);
            let path = path.trim();
            if !path.is_empty() {
                return Some(std::path::PathBuf::from(path));
            }
        }
    }

    // 2. ~/.local/bin/conduit-daemon
    if let Ok(home) = std::env::var("HOME") {
        let candidate = std::path::PathBuf::from(home)
            .join(".local")
            .join("bin")
            .join("conduit-daemon");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    // 3 & 4. Relative to the app executable (dev mode) — the sidecar check
    // above (step 0) already covers `exe_dir/conduit-daemon` directly.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // Go up from target/{debug,release}/ to project root
            for profile in &["debug", "release"] {
                let candidate = exe_dir
                    .parent()
                    .and_then(|p| p.parent())
                    .map(|root| root.join("target").join(profile).join("conduit-daemon"));
                if let Some(c) = candidate {
                    if c.exists() {
                        return Some(c);
                    }
                }
            }
        }
    }

    None
}

// ---- Extra response types ----

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CapturedKey {
    pub name: String,
    pub code: u16,
}

// ---- Long-lived subscription threads ----

/// Spawn a thread that maintains a persistent SubscribeStatus connection,
/// forwarding each Push::Status as a "conduit://status" Tauri event.
/// Reconnects every 1 s on failure, emitting connected/disconnected events.
fn spawn_status_subscription(app: AppHandle) {
    thread::spawn(move || {
        loop {
            let _ = subscribe_loop(&app, Request::SubscribeStatus, "conduit://status");
            // Emit disconnected, wait, then retry
            let _ = app.emit("conduit://disconnected", ());
            thread::sleep(Duration::from_secs(1));
        }
    });
}

/// Spawn a thread that maintains a persistent SubscribeEvents connection,
/// forwarding each Push::Event as a "conduit://event" Tauri event.
fn spawn_events_subscription(app: AppHandle) {
    thread::spawn(move || {
        loop {
            let _ = subscribe_loop(&app, Request::SubscribeEvents, "conduit://event");
            let _ = app.emit("conduit://disconnected", ());
            thread::sleep(Duration::from_secs(1));
        }
    });
}

/// Open a subscription connection and forward push frames until error.
/// Emits "conduit://connected" once the subscription is acknowledged.
fn subscribe_loop(
    app: &AppHandle,
    req: Request,
    _event_name: &str, // kept for documentation clarity; we inspect Push variant
) -> Result<(), String> {
    let path = socket_path();
    let mut stream = UnixStream::connect(&path)
        .map_err(|e| format!("connect {}: {}", path.display(), e))?;

    // Send the subscribe request
    let line = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    stream
        .write_all(line.as_bytes())
        .and_then(|_| stream.write_all(b"\n"))
        .map_err(|e| format!("write: {}", e))?;

    let mut reader = BufReader::new(&stream);

    // Read the "subscribed" acknowledgement
    let mut ack = String::new();
    reader
        .read_line(&mut ack)
        .map_err(|e| format!("read ack: {}", e))?;
    let ack_resp: Response = serde_json::from_str(ack.trim())
        .map_err(|e| format!("parse ack: {}", e))?;
    match ack_resp {
        Response::Subscribed => {}
        Response::Err { message, .. } => return Err(message),
        other => return Err(format!("unexpected ack: {:?}", other)),
    }

    // Signal connected
    let _ = app.emit("conduit://connected", ());

    // Forward push frames
    loop {
        let mut push_line = String::new();
        let n = reader
            .read_line(&mut push_line)
            .map_err(|e| format!("read push: {}", e))?;
        if n == 0 {
            return Err("connection closed".into());
        }
        let push: Push = match serde_json::from_str(push_line.trim()) {
            Ok(p) => p,
            Err(e) => return Err(format!("parse push: {}", e)),
        };
        match push {
            Push::Status(s) => {
                let _ = app.emit("conduit://status", s);
            }
            Push::Event(ev) => {
                let _ = app.emit("conduit://event", ev);
            }
        }
    }
}

// ---- Desktop app listing ----

#[tauri::command]
async fn list_installed_apps() -> Result<Vec<apps::InstalledApp>, ErrorPayload> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| ErrorPayload::new("internal", "HOME not set", ""))?;

    let dirs = vec![
        PathBuf::from("/usr/share/applications"),
        home.join(".local/share/applications"),
        PathBuf::from("/var/lib/flatpak/exports/share/applications"),
    ];

    let mut installed = apps::list_installed_apps_impl(&dirs);

    // Resolve icons after parsing (parse returns raw Icon= value)
    for app in &mut installed {
        app.icon = app.icon.as_deref().and_then(apps::resolve_icon);
    }

    Ok(installed)
}

// ---- Tray / window visibility ----

/// Show the main window and give it focus (used by the tray "Open" item and
/// on normal, non-`--hidden` launch).
fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Tracks whether tray setup succeeded. When it didn't, there is no tray to
/// restore the window from, so close-to-tray must not hide the window (the
/// app should just exit normally on close instead of vanishing).
static TRAY_OK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Build the tray icon/menu. Returns `Err` instead of panicking if any step
/// fails (e.g. no bundle icon available) so the caller can fall back to a
/// visible window rather than letting Tauri panic the whole process out of
/// `.setup()`.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| tauri::Error::AssetNotFound("bundle icon".into()))?;

    let open_item = MenuItem::with_id(app, "open", "Open Conduit", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_item, &quit_item])?;
    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;

    Ok(())
}

// ---- App entry point ----

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            spawn_status_subscription(handle.clone());
            spawn_events_subscription(handle);

            let hidden = std::env::args().any(|a| a == "--hidden");
            let tray_ok = build_tray(app)
                .map_err(|e| eprintln!("conduit-ui: tray unavailable: {e}"))
                .is_ok();
            TRAY_OK.store(tray_ok, std::sync::atomic::Ordering::SeqCst);

            if !hidden || !tray_ok {
                show_main_window(&app.handle());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if TRAY_OK.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
                // If the tray isn't available, let the close proceed normally
                // (a hidden window with no tray would be unreachable).
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_status,
            get_config,
            set_config,
            list_devices,
            list_windows,
            suspend,
            resume,
            capture_next_key,
            list_installed_apps,
            setup::setup_status,
            setup::setup_install_service,
            setup::setup_fix_permissions,
            setup::restart_engine,
            setup::collect_report,
            ratbag::ratbag_stage_device_file,
            ratbag::ratbag_status,
            ratbag::ratbag_read_buttons,
            ratbag::ratbag_fix_setup,
            ratbag::ratbag_suggest_rewrites,
            ratbag::ratbag_rewrite,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
