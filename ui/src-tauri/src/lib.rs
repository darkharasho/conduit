use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use conduit_proto::{Push, Request, Response};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

// ---- Re-export proto types as Tauri-serializable types ----
// (conduit_proto already derives Serialize/Deserialize)

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
fn one_shot(req: &Request) -> Result<Response, String> {
    let path = socket_path();
    let mut stream = UnixStream::connect(&path)
        .map_err(|e| format!("connect {}: {}", path.display(), e))?;
    let line = serde_json::to_string(req).map_err(|e| e.to_string())?;
    stream
        .write_all(line.as_bytes())
        .and_then(|_| stream.write_all(b"\n"))
        .map_err(|e| format!("write: {}", e))?;
    let mut reader = BufReader::new(&stream);
    let mut resp_line = String::new();
    reader
        .read_line(&mut resp_line)
        .map_err(|e| format!("read: {}", e))?;
    serde_json::from_str::<Response>(resp_line.trim())
        .map_err(|e| format!("parse response: {}", e))
}

/// Extract an Err response into a Tauri command error.
fn check_ok(resp: Response) -> Result<(), String> {
    match resp {
        Response::Ok => Ok(()),
        Response::Err { message } => Err(message),
        other => Err(format!("unexpected response: {:?}", other)),
    }
}

// ---- Tauri commands ----

#[tauri::command]
async fn get_status() -> Result<conduit_proto::Status, String> {
    match one_shot(&Request::GetStatus)? {
        Response::Status(s) => Ok(s),
        Response::Err { message } => Err(message),
        other => Err(format!("unexpected: {:?}", other)),
    }
}

#[tauri::command]
async fn get_config() -> Result<String, String> {
    match one_shot(&Request::GetConfig)? {
        Response::Config { toml } => Ok(toml),
        Response::Err { message } => Err(message),
        other => Err(format!("unexpected: {:?}", other)),
    }
}

#[tauri::command]
async fn set_config(toml: String) -> Result<(), String> {
    let resp = one_shot(&Request::SetConfig { toml })?;
    check_ok(resp)
}

#[tauri::command]
async fn list_devices() -> Result<Vec<conduit_proto::DeviceInfo>, String> {
    match one_shot(&Request::ListDevices)? {
        Response::Devices { devices } => Ok(devices),
        Response::Err { message } => Err(message),
        other => Err(format!("unexpected: {:?}", other)),
    }
}

#[tauri::command]
async fn list_windows() -> Result<Vec<conduit_proto::FocusInfo>, String> {
    match one_shot(&Request::ListWindows)? {
        Response::Windows { windows } => Ok(windows),
        Response::Err { message } => Err(message),
        other => Err(format!("unexpected: {:?}", other)),
    }
}

#[tauri::command]
async fn suspend() -> Result<(), String> {
    let resp = one_shot(&Request::Suspend)?;
    check_ok(resp)
}

#[tauri::command]
async fn resume() -> Result<(), String> {
    let resp = one_shot(&Request::Resume)?;
    check_ok(resp)
}

#[tauri::command]
async fn capture_next_key() -> Result<CapturedKey, String> {
    match one_shot(&Request::CaptureNextKey)? {
        Response::CapturedKey { name, code } => Ok(CapturedKey { name, code }),
        Response::Err { message } => Err(message),
        other => Err(format!("unexpected: {:?}", other)),
    }
}

/// Stub: full implementation in Task 20.
#[tauri::command]
async fn check_setup() -> Result<SetupResult, String> {
    let daemon_ok = UnixStream::connect(socket_path()).is_ok();
    Ok(SetupResult { daemon: daemon_ok })
}

// ---- Extra response types ----

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CapturedKey {
    pub name: String,
    pub code: u16,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SetupResult {
    pub daemon: bool,
}

// ---- Long-lived subscription threads ----

/// Spawn a thread that maintains a persistent SubscribeStatus connection,
/// forwarding each Push::Status as a "conduit://status" Tauri event.
/// Reconnects every 1 s on failure, emitting connected/disconnected events.
fn spawn_status_subscription(app: AppHandle) {
    thread::spawn(move || {
        loop {
            match subscribe_loop(&app, Request::SubscribeStatus, "conduit://status") {
                Ok(_) => {}
                Err(_) => {}
            }
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
            match subscribe_loop(&app, Request::SubscribeEvents, "conduit://event") {
                Ok(_) => {}
                Err(_) => {}
            }
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
        Response::Err { message } => return Err(message),
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

// ---- App entry point ----

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();
            spawn_status_subscription(handle.clone());
            spawn_events_subscription(handle);
            Ok(())
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
            check_setup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
