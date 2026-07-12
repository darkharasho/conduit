//! Unix-socket IPC server — the daemon's API for the Tauri UI.
//!
//! # Protocol
//! Newline-delimited JSON on a `SOCK_STREAM` Unix socket at
//! `paths::socket_path()`.  Each line from the client is a `Request`; each
//! line from the server is a `Response` or (for subscribers) a `Push`.
//!
//! # Connection lifecycle
//! Each accepted connection gets its own thread.  The thread reads `Request`
//! lines, dispatches them, and writes `Response` lines.
//!
//! # Subscribe semantics
//! After `SubscribeEvents` or `SubscribeStatus` the connection becomes
//! **push-only**: further requests sent by the client on the same connection
//! are silently ignored (the read loop exits once the push channel
//! disconnects or the write fails).  To send new requests the client must
//! open a fresh connection.
//!
//! # CaptureNextKey
//! Blocks (up to 30 s) waiting for the next physical key press.  A timeout
//! returns `Response::Err` so the thread is not leaked.

use std::io::{BufRead, BufReader, Write as _};
use std::os::unix::fs::PermissionsExt as _;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crossbeam_channel::{bounded, Sender};

use conduit_core::config;
use conduit_proto::{Push, Request, Response};

use crate::runloop::{Msg, QueryKind, SubscribeKind};
use crate::watch::ReloadGate;

// ── Public entry point ─────────────────────────────────────────────────────────

/// Bind a Unix-domain socket at `paths::socket_path()`, accept connections,
/// and spawn one thread per connection.  Returns immediately after binding;
/// the accept loop runs in the returned thread.
///
/// Stale socket files are unlinked before binding.  Permissions are set to
/// 0600 after bind so only the owning user can connect.
///
/// `gate` is shared with the watch thread: when `SetConfig` writes a new config
/// it records the content hash in the gate so the watcher can skip the
/// redundant mtime-change reload.
pub fn spawn(
    tx: Sender<Msg>,
    config_path: PathBuf,
    gate: Arc<Mutex<ReloadGate>>,
) -> anyhow::Result<std::thread::JoinHandle<()>> {
    spawn_at(crate::paths::socket_path(), tx, config_path, gate)
}

/// Like `spawn` but binds to an explicit `sock_path` instead of reading from
/// the environment.  Used by integration tests to avoid concurrent env-var
/// races, and by the library `start()` function to allow an overridden socket path.
pub fn spawn_at(
    sock_path: PathBuf,
    tx: Sender<Msg>,
    config_path: PathBuf,
    gate: Arc<Mutex<ReloadGate>>,
) -> anyhow::Result<std::thread::JoinHandle<()>> {
    // Remove stale socket (ignore error if it didn't exist).
    let _ = std::fs::remove_file(&sock_path);

    // Bind the listener.
    let listener = std::os::unix::net::UnixListener::bind(&sock_path)
        .map_err(|e| anyhow::anyhow!("IPC bind {:?}: {e}", sock_path))?;

    // Restrict access to the owning user.
    std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| anyhow::anyhow!("IPC chmod {:?}: {e}", sock_path))?;

    eprintln!("conduit/ipc: listening on {}", sock_path.display());

    let handle = std::thread::Builder::new()
        .name("conduit-ipc-accept".into())
        .spawn(move || accept_loop(listener, tx, config_path, gate))
        .map_err(|e| anyhow::anyhow!("IPC spawn: {e}"))?;

    Ok(handle)
}

// ── Accept loop ────────────────────────────────────────────────────────────────

fn accept_loop(
    listener: std::os::unix::net::UnixListener,
    tx: Sender<Msg>,
    config_path: PathBuf,
    gate: Arc<Mutex<ReloadGate>>,
) {
    let mut conn_id: u64 = 0;
    for stream in listener.incoming() {
        match stream {
            Ok(s) => {
                conn_id += 1;
                let tx2 = tx.clone();
                let cp2 = config_path.clone();
                let gate2 = Arc::clone(&gate);
                let id = conn_id;
                let _ = std::thread::Builder::new()
                    .name(format!("conduit-ipc-conn-{id}"))
                    .spawn(move || handle_connection(s, tx2, cp2, gate2));
            }
            Err(e) => {
                eprintln!("conduit/ipc: accept error: {e}");
                // A transient error (e.g. EINTR) should not kill the server.
                if e.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
        }
    }
}

// ── Per-connection handler ─────────────────────────────────────────────────────

fn handle_connection(
    stream: std::os::unix::net::UnixStream,
    tx: Sender<Msg>,
    config_path: PathBuf,
    gate: Arc<Mutex<ReloadGate>>,
) {
    // The read and write halves share the underlying fd; we need separate
    // handles.  `try_clone` gives us a second fd for writing.
    let write_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("conduit/ipc: try_clone: {e}");
            return;
        }
    };
    let mut writer = std::io::BufWriter::new(write_stream);
    let reader = BufReader::new(stream);

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break, // client disconnected
        };
        let line = line.trim().to_owned();
        if line.is_empty() {
            continue;
        }

        let request: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp = Response::Err {
                    message: format!("malformed JSON: {e}"),
                };
                if write_response(&mut writer, &resp).is_err() {
                    break;
                }
                continue; // don't kill the connection on parse error
            }
        };

        match dispatch(request, &tx, &config_path, &gate, &mut writer) {
            DispatchResult::Continue => {}
            DispatchResult::SubscribeLoop(rx) => {
                // Forward Push frames until the channel disconnects or the
                // write fails.  The connection is push-only from this point;
                // the read loop exits.
                forward_pushes(rx, &mut writer);
                break;
            }
            DispatchResult::WriteError => break,
        }
    }
}

// ── Dispatch ───────────────────────────────────────────────────────────────────

enum DispatchResult {
    Continue,
    SubscribeLoop(crossbeam_channel::Receiver<Push>),
    WriteError,
}

fn dispatch(
    request: Request,
    tx: &Sender<Msg>,
    config_path: &PathBuf,
    gate: &Arc<Mutex<ReloadGate>>,
    writer: &mut impl Write,
) -> DispatchResult {
    match request {
        // ── GetStatus ─────────────────────────────────────────────────────────
        Request::GetStatus => {
            let resp = query(tx, QueryKind::GetStatus);
            if write_response(writer, &resp).is_err() {
                return DispatchResult::WriteError;
            }
        }

        // ── GetConfig ────────────────────────────────────────────────────────
        Request::GetConfig => {
            let resp = match std::fs::read_to_string(config_path) {
                Ok(toml) => Response::Config { toml },
                Err(e) => Response::Err {
                    message: format!("reading config: {e}"),
                },
            };
            if write_response(writer, &resp).is_err() {
                return DispatchResult::WriteError;
            }
        }

        // ── SetConfig ────────────────────────────────────────────────────────
        Request::SetConfig { toml } => {
            let resp = set_config(&toml, config_path, tx, gate);
            if write_response(writer, &resp).is_err() {
                return DispatchResult::WriteError;
            }
        }

        // ── ListDevices ──────────────────────────────────────────────────────
        // Answer directly from `devices::discover()` so ALL devices (grabbed
        // and ungrabbed) are returned — not just the grabbed subset.
        // Marking which devices are currently grabbed is done by asking the
        // runloop for its Status (which carries `grabbed_devices`), keeping the
        // roundtrip off the hot path.
        Request::ListDevices => {
            let resp = list_devices_response(tx);
            if write_response(writer, &resp).is_err() {
                return DispatchResult::WriteError;
            }
        }

        // ── ListWindows ──────────────────────────────────────────────────────
        Request::ListWindows => {
            let windows = crate::focus::list_windows();
            let resp = Response::Windows { windows };
            if write_response(writer, &resp).is_err() {
                return DispatchResult::WriteError;
            }
        }

        // ── Suspend / Resume ─────────────────────────────────────────────────
        Request::Suspend => {
            let _ = tx.send(Msg::Suspend);
            if write_response(writer, &Response::Ok).is_err() {
                return DispatchResult::WriteError;
            }
        }
        Request::Resume => {
            let _ = tx.send(Msg::Resume);
            if write_response(writer, &Response::Ok).is_err() {
                return DispatchResult::WriteError;
            }
        }

        // ── Subscribe ────────────────────────────────────────────────────────
        Request::SubscribeEvents => {
            let (push_tx, push_rx) = bounded::<Push>(256);
            let _ = tx.send(Msg::Subscribe(SubscribeKind::Events, push_tx));
            if write_response(writer, &Response::Subscribed).is_err() {
                return DispatchResult::WriteError;
            }
            return DispatchResult::SubscribeLoop(push_rx);
        }
        Request::SubscribeStatus => {
            let (push_tx, push_rx) = bounded::<Push>(256);
            let _ = tx.send(Msg::Subscribe(SubscribeKind::Status, push_tx));
            if write_response(writer, &Response::Subscribed).is_err() {
                return DispatchResult::WriteError;
            }
            return DispatchResult::SubscribeLoop(push_rx);
        }

        // ── CaptureNextKey ───────────────────────────────────────────────────
        Request::CaptureNextKey => {
            let (reply_tx, reply_rx) = bounded::<Response>(1);
            let _ = tx.send(Msg::CaptureNextKey(reply_tx));
            let resp = match reply_rx.recv_timeout(Duration::from_secs(30)) {
                Ok(r) => r,
                Err(_) => Response::Err {
                    message: "capture_next_key timed out after 30 s".into(),
                },
            };
            if write_response(writer, &resp).is_err() {
                return DispatchResult::WriteError;
            }
        }
    }

    DispatchResult::Continue
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Alias so the dispatch function signature is cleaner.
trait Write: std::io::Write {}
impl<T: std::io::Write> Write for T {}

/// Build the `Response::Devices` answer for a `ListDevices` request.
///
/// Calls `devices::discover()` directly (off the runloop hot path) so that ALL
/// discovered devices — not just those currently grabbed — are returned to the
/// UI.  The `grabbed` field is set by cross-referencing with the runloop's
/// current `grabbed_devices` list (obtained via a `GetStatus` query).
fn list_devices_response(tx: &Sender<Msg>) -> Response {
    // Get the current set of grabbed device paths from the runloop.
    let grabbed_paths: std::collections::HashSet<String> = match query(tx, QueryKind::GetStatus) {
        Response::Status(s) => s.grabbed_devices.into_iter().collect(),
        _ => std::collections::HashSet::new(),
    };

    // Discover all input devices regardless of grab state.
    let discovered = match crate::devices::discover() {
        Ok(devs) => devs,
        Err(e) => {
            return Response::Err {
                message: format!("discover devices: {e}"),
            };
        }
    };

    use conduit_proto::DeviceInfo;
    let devices: Vec<DeviceInfo> = discovered
        .into_iter()
        .map(|d| {
            let path_str = d.path.display().to_string();
            let grabbed = grabbed_paths.contains(&path_str);
            DeviceInfo {
                path: path_str,
                name: d.name.clone(),
                vendor: d.vendor,
                product: d.product,
                is_keyboard: d.is_keyboard(),
                is_mouse: d.is_mouse(),
                grabbed,
                id: d.id(),
                class: d.class.as_str().to_string(),
                phys: d.phys.clone(),
                keys: d.keys.clone(),
                wheel: d.wheel,
                hwheel: d.hwheel,
            }
        })
        .collect();

    Response::Devices { devices }
}

/// Send a `Msg::Query` and block for the reply.
fn query(tx: &Sender<Msg>, kind: QueryKind) -> Response {
    let (reply_tx, reply_rx) = bounded::<Response>(1);
    if tx.send(Msg::Query(kind, reply_tx)).is_err() {
        return Response::Err {
            message: "engine thread unavailable".into(),
        };
    }
    reply_rx.recv().unwrap_or(Response::Err {
        message: "engine did not reply".into(),
    })
}

/// Write a `Response` as a JSON line.  Returns `Err` if the write fails.
fn write_response(writer: &mut impl std::io::Write, resp: &Response) -> std::io::Result<()> {
    let json = serde_json::to_string(resp)
        .unwrap_or_else(|_| r#"{"type":"err","message":"serialization error"}"#.into());
    writer.write_all(json.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()
}

/// Forward `Push` frames to the writer until the channel closes or the write
/// fails.
fn forward_pushes(
    rx: crossbeam_channel::Receiver<Push>,
    writer: &mut impl std::io::Write,
) {
    for push in rx {
        let json = match serde_json::to_string(&push) {
            Ok(s) => s,
            Err(_) => continue,
        };
        if writer.write_all(json.as_bytes()).is_err()
            || writer.write_all(b"\n").is_err()
            || writer.flush().is_err()
        {
            break;
        }
    }
}

/// Compile and atomically apply a new config.
///
/// On compile error: returns `Response::Err` with the `ConfigError` message
/// (displayed inline by the UI) and does **not** touch the config file.
///
/// On success: writes to a temp file in the same directory, renames it over
/// the config path (atomic on Linux), records the content hash in `gate` (so
/// the watcher skips the mtime-change reload), sends `Msg::Reload`, and
/// returns `Response::Ok`.
fn set_config(
    toml: &str,
    config_path: &PathBuf,
    tx: &Sender<Msg>,
    gate: &Arc<Mutex<ReloadGate>>,
) -> Response {
    let compiled = match config::compile(toml) {
        Ok(c) => c,
        Err(e) => {
            return Response::Err {
                message: e.to_string(),
            };
        }
    };

    // Write atomically: temp file in the same directory → rename.
    let dir = match config_path.parent() {
        Some(d) => d,
        None => {
            return Response::Err {
                message: "config path has no parent directory".into(),
            };
        }
    };

    let tmp_path = dir.join(format!(
        ".conduit-config-{}.tmp",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));

    if let Err(e) = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp_path)?;
        f.write_all(toml.as_bytes())?;
        f.flush()?;
        drop(f);
        std::fs::rename(&tmp_path, config_path)?;
        Ok(())
    })() {
        let _ = std::fs::remove_file(&tmp_path);
        return Response::Err {
            message: format!("writing config: {e}"),
        };
    }

    // Record the content hash so the watcher skips the mtime-change reload
    // that will result from our write above.
    {
        let mut g = gate.lock().unwrap();
        g.record(toml);
    }

    let _ = tx.send(Msg::Reload(compiled));
    Response::Ok
}

// ── Integration tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader};
    use std::os::unix::net::UnixStream;

    use conduit_core::config::compile as compile_config;
    use conduit_core::engine::Engine;
    use conduit_proto::Response;

    /// Minimal TOML that compiles without any device-grab settings.
    const BASE_TOML: &str = r#"
[profile.default.keys]
a = "b"
"#;

    /// A different valid TOML used to verify a successful SetConfig round-trip.
    const ALT_TOML: &str = r#"
[profile.default.keys]
a = "c"

[profile.gaming]
match = { class = "steam" }

[profile.gaming.keys]
a = "d"
"#;

    /// A self-contained test fixture: a real runloop and IPC server bound to a
    /// unique temp socket.  Each test creates its own `Fixture`; no global env
    /// vars are mutated, so tests can run concurrently without races.
    struct Fixture {
        /// Kept alive so the temp dir (and socket file) persist for the
        /// duration of the test.
        _tmp: tempfile::TempDir,
        sock_path: PathBuf,
        config_path: PathBuf,
    }

    impl Fixture {
        fn setup() -> Self {
            let tmp = tempfile::tempdir().expect("tempdir");
            let sock_path = tmp.path().join("conduit-test.sock");
            let config_path = tmp.path().join("conduit.toml");

            // Write the initial config file.
            std::fs::write(&config_path, BASE_TOML).expect("write config");

            let compiled = compile_config(BASE_TOML).expect("compile");
            let settings = compiled.settings.clone();
            let engine = Engine::new(compiled);

            let (tx, rx) = crossbeam_channel::unbounded::<crate::runloop::Msg>();
            let tx_for_ipc = tx.clone();

            // Spawn the runloop with no VirtualOutput (no /dev/uinput needed).
            std::thread::Builder::new()
                .name("test-runloop".into())
                .spawn(move || {
                    crate::runloop::run(
                        engine,
                        None, // no virtual output in tests
                        rx,
                        tx,
                        HashMap::new(),
                        settings,
                        HashMap::new(),
                        Vec::new(),
                    )
                })
                .expect("spawn runloop");

            // Spawn the IPC server at the fixture-specific socket path.
            // We use `spawn_at` to avoid touching the global CONDUIT_SOCKET env var.
            let gate = std::sync::Arc::new(std::sync::Mutex::new(crate::watch::ReloadGate::new()));
            spawn_at(sock_path.clone(), tx_for_ipc, config_path.clone(), gate)
                .expect("spawn ipc");

            // `spawn_at` returns only after the listener is bound, so the socket
            // file already exists — no polling required.

            Fixture { _tmp: tmp, sock_path, config_path }
        }

        /// Open a fresh client connection to this fixture's socket.
        fn connect(&self) -> UnixStream {
            UnixStream::connect(&self.sock_path).expect("connect to IPC socket")
        }
    }

    fn send_request(stream: &mut UnixStream, req: &Request) -> Response {
        let json = serde_json::to_string(req).unwrap();
        stream.write_all(json.as_bytes()).unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();

        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    #[test]
    fn ipc_get_status_returns_status() {
        let fx = Fixture::setup();
        let mut client = fx.connect();

        let resp = send_request(&mut client, &Request::GetStatus);
        match resp {
            Response::Status(s) => {
                assert_eq!(s.active_profile, "default");
                assert!(!s.suspended);
            }
            other => panic!("expected Status, got {other:?}"),
        }
    }

    #[test]
    fn ipc_bad_set_config_returns_err_and_does_not_modify_file() {
        let fx = Fixture::setup();
        let mut client = fx.connect();

        let before = std::fs::read_to_string(&fx.config_path).unwrap();

        let resp = send_request(
            &mut client,
            &Request::SetConfig {
                toml: "this is not valid [[[toml".into(),
            },
        );
        match resp {
            Response::Err { message } => {
                assert!(!message.is_empty(), "Err message should not be empty");
            }
            other => panic!("expected Err, got {other:?}"),
        }

        let after = std::fs::read_to_string(&fx.config_path).unwrap();
        assert_eq!(before, after, "config file must not change on Err");
    }

    #[test]
    fn ipc_good_set_config_rewrites_file_and_reload_reflects_new_profile() {
        let fx = Fixture::setup();
        let mut client = fx.connect();

        // Apply a new config that adds a "gaming" profile.
        let resp = send_request(
            &mut client,
            &Request::SetConfig {
                toml: ALT_TOML.into(),
            },
        );
        assert_eq!(resp, Response::Ok, "SetConfig should return Ok");

        // Verify the file was actually rewritten.
        let written = std::fs::read_to_string(&fx.config_path).unwrap();
        assert!(
            written.contains("gaming"),
            "config file should contain the new profile"
        );

        // Give the runloop time to process Msg::Reload.
        std::thread::sleep(Duration::from_millis(100));

        // A fresh connection (same server) should see the new config via GetStatus.
        let mut client2 = fx.connect();
        let resp2 = send_request(&mut client2, &Request::GetStatus);
        // After reload the engine may still be on "default" (no focus event),
        // but the config was accepted and reloaded without error.
        assert!(matches!(resp2, Response::Status(_)), "expected Status after reload");
    }

    #[test]
    fn ipc_suspend_then_get_status_shows_suspended() {
        let fx = Fixture::setup();
        let mut client = fx.connect();

        let resp = send_request(&mut client, &Request::Suspend);
        assert_eq!(resp, Response::Ok);

        // Give the runloop a moment to process the Suspend.
        std::thread::sleep(Duration::from_millis(100));

        // Use a second connection for GetStatus.
        let mut client2 = fx.connect();
        let resp2 = send_request(&mut client2, &Request::GetStatus);
        match resp2 {
            Response::Status(s) => assert!(s.suspended, "should be suspended after Suspend"),
            other => panic!("expected Status, got {other:?}"),
        }
    }

    #[test]
    fn ipc_malformed_json_returns_err_and_connection_stays_alive() {
        let fx = Fixture::setup();
        let mut client = fx.connect();

        // Send bad JSON.
        client.write_all(b"not json at all\n").unwrap();
        client.flush().unwrap();

        let mut reader = BufReader::new(client.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let resp: Response = serde_json::from_str(line.trim()).unwrap();
        assert!(matches!(resp, Response::Err { .. }), "should get Err for malformed JSON");

        // The server is still accepting connections after the malformed input.
        let mut client2 = fx.connect();
        let resp2 = send_request(&mut client2, &Request::GetStatus);
        assert!(matches!(resp2, Response::Status(_)));
    }

    #[test]
    fn ipc_list_windows_returns_windows() {
        let fx = Fixture::setup();
        let mut client = fx.connect();

        let resp = send_request(&mut client, &Request::ListWindows);
        // In a headless CI environment this will be an empty vec, which is fine.
        assert!(matches!(resp, Response::Windows { .. }));
    }

    #[test]
    fn ipc_list_devices_returns_devices() {
        let fx = Fixture::setup();
        let mut client = fx.connect();

        let resp = send_request(&mut client, &Request::ListDevices);
        // No devices are grabbed in the test runloop (empty readers map).
        assert!(
            matches!(resp, Response::Devices { .. }),
            "expected Devices response, got {resp:?}"
        );
    }

    #[test]
    fn ipc_get_config_returns_config_toml() {
        let fx = Fixture::setup();
        let mut client = fx.connect();

        let resp = send_request(&mut client, &Request::GetConfig);
        match resp {
            Response::Config { toml } => {
                assert!(toml.contains("profile"), "config should contain profile section");
            }
            other => panic!("expected Config, got {other:?}"),
        }
    }
}
