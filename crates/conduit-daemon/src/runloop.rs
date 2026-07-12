//! The daemon's central run loop: receive messages from reader/IPC/focus
//! threads, translate through the core `Engine`, and emit to the virtual
//! output devices.
//!
//! # Threading model
//! - One reader thread per grabbed device (see `devices::spawn_reader`) sends
//!   `Msg::Input` over a crossbeam channel.
//! - The engine thread (`run`) owns the `Engine`, the subscriber lists, the
//!   reader registry, and the last-known focus. It sleeps in `recv_timeout`
//!   bounded by the engine's next tap-hold deadline so ticks fire on time.
//! - Mouse motion (EV_REL/EV_MSC) never enters this loop — readers forward it
//!   straight to the virtual mouse (`VirtualOutput::emit_raw_mouse`).
//!
//! # Time base
//! `now_us()` counts monotonic microseconds from a process-start `Instant`.
//! Reader threads stamp events at read time; no kernel-timestamp
//! reconciliation is attempted in v1.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crossbeam_channel::{Receiver, Sender, TrySendError};

use conduit_core::config::{CompiledConfig, FocusFields, Settings};
use conduit_core::engine::Engine;
use conduit_core::event::{Event, KeyState};
use conduit_proto::{EventPhase, FocusInfo, Push, Response, Status, WireEvent};

use crate::devices::GrabHandle;
use crate::output::VirtualOutput;

/// Which push stream a subscriber wants.
/// Constructed by the IPC task (12); matched here.
#[allow(dead_code)]
#[derive(Debug)]
pub enum SubscribeKind {
    Events,
    Status,
}

/// Queries answered inline by the engine thread from engine state.
/// Constructed by the IPC task (12); matched here.
#[allow(dead_code)]
#[derive(Debug)]
pub enum QueryKind {
    GetStatus,
    /// List discovered + grabbed devices.  The runloop returns the grabbed
    /// device paths; the IPC layer probes them to fill in DeviceInfo fields.
    Devices,
}

/// Central message type for the daemon engine thread.
///
/// `Input` and `DeviceRemoved` are produced by reader threads (Task 11);
/// the remaining variants are constructed by the IPC and focus-tracking
/// threads (Tasks 12-14).
#[allow(dead_code)]
pub enum Msg {
    Input(Event),
    Focus(FocusInfo),
    Reload(CompiledConfig),
    Suspend,
    Resume,
    DeviceAdded(PathBuf),
    DeviceRemoved(PathBuf),
    Subscribe(SubscribeKind, Sender<Push>),
    Query(QueryKind, Sender<Response>),
    CaptureNextKey(Sender<Response>),
    /// Graceful shutdown signal: the run loop exits immediately upon receiving
    /// this message.  Sent by `DaemonHandle::shutdown()` so tests can stop the
    /// daemon without having to wait for every sender clone to be dropped.
    Shutdown,
}

// ── Time base ─────────────────────────────────────────────────────────────────

static TIME_BASE: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();

/// Monotonic microseconds since process start. First call pins the base;
/// `main` calls this early so the base predates all threads.
pub fn now_us() -> u64 {
    TIME_BASE.get_or_init(Instant::now).elapsed().as_micros() as u64
}

// ── Engine dispatch (unit-testable core) ──────────────────────────────────────

/// Pure dispatch: drive the engine with one message (`None` = deadline tick).
/// Returns the events the engine emitted. No output emission, no subscriber
/// pushes — that is `run`'s job. This is the unit-testable core of the loop.
///
/// `Reload` and the control-plane variants (`DeviceAdded`/`DeviceRemoved`,
/// `Subscribe`, `Query`, `CaptureNextKey`) are handled directly by `run`,
/// which owns the state they need (current focus, subscriber lists, reader
/// registry); for those this function returns no events.
pub fn drive(engine: &mut Engine, msg: Option<Msg>, now_us: u64) -> Vec<Event> {
    match msg {
        None => engine.tick(now_us).to_vec(),
        Some(Msg::Input(ev)) => engine.handle(ev).to_vec(),
        Some(Msg::Focus(f)) => {
            engine.set_focus(&FocusFields {
                process: &f.process,
                class: &f.class,
                title: &f.title,
            });
            Vec::new()
        }
        Some(Msg::Suspend) => engine.suspend().to_vec(),
        Some(Msg::Resume) => {
            engine.resume();
            Vec::new()
        }
        Some(_) => Vec::new(),
    }
}

// ── The engine thread ─────────────────────────────────────────────────────────

/// The engine thread: receives `Msg`, drives the `Engine`, emits translated
/// events to `out`, and pushes pre/post wire events to subscribers.
///
/// Owns the reader registry: on `DeviceAdded` the engine probes the path and
/// (if it should be grabbed) spawns a reader thread; on `DeviceRemoved` the
/// corresponding `GrabHandle` is dropped (the reader thread has already
/// exited; dropping joins it). Returns when every `Sender<Msg>` has been
/// dropped.
///
/// `tx` is a clone used to give to newly spawned reader threads so they can
/// send `Msg::DeviceRemoved` on unplug.  `settings` is kept up-to-date via
/// `Msg::Reload`.
///
/// `out` is `None` in test environments where `/dev/uinput` is not available;
/// events are computed by the engine but not forwarded to a virtual device.
pub fn run(
    mut engine: Engine,
    out: Option<Arc<Mutex<VirtualOutput>>>,
    rx: Receiver<Msg>,
    tx: Sender<Msg>,
    mut readers: HashMap<PathBuf, GrabHandle>,
    mut settings: Settings,
) {
    // Subscriber senders must come from bounded channels (cap 256, created by
    // the IPC task); a slow consumer is dropped on the first failed try_send.
    let mut event_subs: Vec<Sender<Push>> = Vec::new();
    let mut status_subs: Vec<Sender<Push>> = Vec::new();
    let mut current_focus: Option<FocusInfo> = None;
    let mut capture_reply: Option<Sender<Response>> = None;
    let mut grabbed_devices: Vec<String> =
        readers.keys().map(|p| p.display().to_string()).collect();
    grabbed_devices.sort();

    loop {
        // Sleep until the next message or the engine's next tap-hold deadline.
        let timeout = engine
            .next_deadline_us()
            .map(|d| Duration::from_micros(d.saturating_sub(now_us())));
        let msg = match timeout {
            Some(t) => match rx.recv_timeout(t) {
                Ok(m) => Some(m),
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => None,
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(m) => Some(m),
                Err(_) => return,
            },
        };

        // Pre-phase push and key capture: every *physical* input event, before
        // any mapping. CaptureNextKey answers on the next PRESS and does NOT
        // consume the event — it still flows through the engine below.
        if let Some(Msg::Input(ev)) = &msg {
            if !event_subs.is_empty() {
                let push = Push::Event(wire_event(ev, EventPhase::Pre));
                event_subs.retain(|tx| try_push(tx, &push));
            }
            if ev.state == KeyState::Press {
                if let Some(reply) = capture_reply.take() {
                    let _ = reply.send(Response::CapturedKey {
                        name: conduit_core::keys::name(ev.key),
                        code: ev.key.0,
                    });
                }
            }
        }

        let now = now_us();
        let outputs: Vec<Event> = match msg {
            Some(Msg::Reload(cfg)) => {
                // swap_config needs the current focus so buffered events
                // replay under the right profile — handled here, not in
                // drive(), because only run() knows the focus.
                let new_settings = cfg.settings.clone();
                let evs = {
                    let (process, class, title) = current_focus
                        .as_ref()
                        .map(|f| (f.process.as_str(), f.class.as_str(), f.title.as_str()))
                        .unwrap_or(("", "", ""));
                    engine
                        .swap_config(cfg, &FocusFields { process, class, title })
                        .to_vec()
                };
                settings = new_settings;
                push_status(&engine, &current_focus, &grabbed_devices, &mut status_subs);
                evs
            }
            Some(Msg::DeviceAdded(p)) => {
                try_grab_device(&p, &settings, &tx, &out, &mut readers, &mut grabbed_devices);
                push_status(&engine, &current_focus, &grabbed_devices, &mut status_subs);
                Vec::new()
            }
            Some(Msg::DeviceRemoved(p)) => {
                // The reader thread has already exited; dropping its handle
                // joins it and releases the (already-dropped) device grab.
                readers.remove(&p);
                let s = p.display().to_string();
                grabbed_devices.retain(|g| g != &s);
                eprintln!("conduit: released {}", p.display());
                push_status(&engine, &current_focus, &grabbed_devices, &mut status_subs);
                Vec::new()
            }
            Some(Msg::Subscribe(kind, tx)) => {
                match kind {
                    SubscribeKind::Events => event_subs.push(tx),
                    SubscribeKind::Status => status_subs.push(tx),
                }
                Vec::new()
            }
            Some(Msg::Query(kind, reply)) => {
                let resp = match kind {
                    QueryKind::GetStatus => Response::Status(build_status(
                        &engine,
                        &current_focus,
                        &grabbed_devices,
                    )),
                    QueryKind::Devices => {
                        // Probe each grabbed path to build DeviceInfo entries.
                        // Devices that can no longer be probed are skipped.
                        use conduit_proto::DeviceInfo;
                        let devices: Vec<DeviceInfo> = grabbed_devices
                            .iter()
                            .filter_map(|p| {
                                crate::devices::probe(std::path::PathBuf::from(p)).map(|d| DeviceInfo {
                                    path: d.path.display().to_string(),
                                    name: d.name.clone(),
                                    vendor: d.vendor,
                                    product: d.product,
                                    is_keyboard: d.is_keyboard(),
                                    is_mouse: d.is_mouse(),
                                    grabbed: true,
                                    id: d.id(),
                                    class: d.class.as_str().to_string(),
                                    phys: d.phys.clone(),
                                })
                            })
                            .collect();
                        Response::Devices { devices }
                    }
                };
                let _ = reply.send(resp);
                Vec::new()
            }
            Some(Msg::CaptureNextKey(reply)) => {
                capture_reply = Some(reply);
                Vec::new()
            }
            Some(Msg::Shutdown) => {
                // Graceful shutdown: exit the run loop immediately.
                return;
            }
            // Engine-driving subset: None (tick), Input, Focus, Suspend, Resume.
            other => {
                let status_changed = matches!(
                    other,
                    Some(Msg::Focus(_)) | Some(Msg::Suspend) | Some(Msg::Resume)
                );
                if let Some(Msg::Focus(f)) = &other {
                    current_focus = Some(f.clone());
                }
                let evs = drive(&mut engine, other, now);
                if status_changed {
                    push_status(&engine, &current_focus, &grabbed_devices, &mut status_subs);
                }
                evs
            }
        };

        if !outputs.is_empty() {
            emit_all(&out, &outputs, &mut event_subs);
        }

        // Belt-and-suspenders (Task 4 review): a handle() that establishes an
        // already-past deadline needs one tick before we sleep again. The
        // engine's tick loops internally over chained expired deadlines.
        if engine.next_deadline_us().is_some_and(|d| d <= now_us()) {
            let extra = engine.tick(now_us()).to_vec();
            if !extra.is_empty() {
                emit_all(&out, &extra, &mut event_subs);
            }
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Attempt to probe and grab a newly-added device.
///
/// Non-blocking: contains_key check → probe → should_grab → spawn_reader →
/// insert + status push.  EACCES settle/retry logic now lives in the hotplug
/// thread (`hotplug::handle_event`) and never runs here.
fn try_grab_device(
    path: &Path,
    settings: &Settings,
    tx: &Sender<Msg>,
    out: &Option<Arc<Mutex<VirtualOutput>>>,
    readers: &mut HashMap<PathBuf, GrabHandle>,
    grabbed_devices: &mut Vec<String>,
) {
    if readers.contains_key(path) {
        return;
    }

    let discovered = match crate::devices::probe(path.to_path_buf()) {
        Some(d) if crate::devices::should_grab(&d, settings) => d,
        _ => return,
    };

    // Cannot spawn a reader without a virtual output to forward events to.
    let Some(out) = out else { return };

    let is_pointer = discovered.is_pointer();
    let handle = crate::devices::spawn_reader(
        path.to_path_buf(),
        is_pointer,
        true, // always grab in production (hotplug path)
        tx.clone(),
        Arc::clone(out),
    );
    readers.insert(path.to_path_buf(), handle);
    let s = path.display().to_string();
    if !grabbed_devices.contains(&s) {
        grabbed_devices.push(s);
        grabbed_devices.sort();
    }
}

/// Emit events to the virtual output and post-phase-push them to subscribers.
///
/// When `out` is `None` (test environments without `/dev/uinput`) the engine's
/// computed events are still pushed to event subscribers but not forwarded to
/// any virtual device.
fn emit_all(out: &Option<Arc<Mutex<VirtualOutput>>>, events: &[Event], subs: &mut Vec<Sender<Push>>) {
    if let Some(out) = out {
        let mut o = out.lock().unwrap();
        for ev in events {
            if let Err(e) = o.emit(ev) {
                eprintln!("conduit: emit error: {e}");
            }
            if !subs.is_empty() {
                let push = Push::Event(wire_event(ev, EventPhase::Post));
                subs.retain(|tx| try_push(tx, &push));
            }
        }
    } else {
        // No virtual output: still push post-phase events to subscribers.
        if !subs.is_empty() {
            for ev in events {
                let push = Push::Event(wire_event(ev, EventPhase::Post));
                subs.retain(|tx| try_push(tx, &push));
            }
        }
    }
}

fn wire_event(ev: &Event, phase: EventPhase) -> WireEvent {
    WireEvent {
        phase,
        key_name: conduit_core::keys::name(ev.key),
        code: ev.key.0,
        state: match ev.state {
            KeyState::Press => "press",
            KeyState::Release => "release",
            KeyState::Repeat => "repeat",
        }
        .to_string(),
        time_us: ev.time_us,
    }
}

/// Non-blocking push; `false` means the subscriber is slow or gone and must
/// be dropped (the hot path never blocks on a UI).
fn try_push(tx: &Sender<Push>, push: &Push) -> bool {
    !matches!(
        tx.try_send(push.clone()),
        Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_))
    )
}

fn build_status(engine: &Engine, focus: &Option<FocusInfo>, grabbed: &[String]) -> Status {
    Status {
        active_profile: engine.active_profile_name().to_string(),
        active_layers: engine
            .active_layer_names()
            .iter()
            .map(|s| s.to_string())
            .collect(),
        suspended: engine.is_suspended(),
        focus: focus.clone(),
        grabbed_devices: grabbed.to_vec(),
        version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

fn push_status(
    engine: &Engine,
    focus: &Option<FocusInfo>,
    grabbed: &[String],
    subs: &mut Vec<Sender<Push>>,
) {
    if subs.is_empty() {
        return;
    }
    let push = Push::Status(build_status(engine, focus, grabbed));
    subs.retain(|tx| try_push(tx, &push));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use conduit_core::config::compile;
    use conduit_core::event::Key;

    fn key(n: &str) -> Key {
        conduit_core::keys::from_name(n).unwrap()
    }
    fn press(n: &str, t: u64) -> Event {
        Event { key: key(n), state: KeyState::Press, time_us: t }
    }
    fn release(n: &str, t: u64) -> Event {
        Event { key: key(n), state: KeyState::Release, time_us: t }
    }
    fn engine_with(toml: &str) -> Engine {
        Engine::new(compile(toml).unwrap())
    }

    #[test]
    fn drive_input_flows_through_remapping() {
        let mut e = engine_with("[profile.default.keys]\na = \"b\"");
        let result = drive(&mut e, Some(Msg::Input(press("a", 0))), 0);
        assert_eq!(result, vec![press("b", 0)]);
    }

    #[test]
    fn drive_none_ticks_expired_deadline() {
        let toml = "[profile.default.keys]\ncapslock = { tap = \"esc\", hold = \"leftctrl\" }";
        let mut e = engine_with(toml);
        drive(&mut e, Some(Msg::Input(press("capslock", 0))), 0);
        let result = drive(&mut e, None, 200_000);
        assert_eq!(result, vec![press("leftctrl", 0)]);
    }

    #[test]
    fn drive_focus_switches_active_profile() {
        let toml = r#"
            [profile.default.keys]
            a = "b"
            [profile.game]
            match = { class = "steam_app_123" }
            keys = { a = "passthrough" }
        "#;
        let mut e = engine_with(toml);
        assert_eq!(e.active_profile_name(), "default");
        let focus = FocusInfo {
            process: "steam_app_123".into(),
            class: "steam_app_123".into(),
            title: "".into(),
        };
        drive(&mut e, Some(Msg::Focus(focus)), 0);
        assert_eq!(e.active_profile_name(), "game");
    }

    #[test]
    fn drive_suspend_returns_flush_events() {
        let mut e = engine_with("[profile.default.keys]\na = \"b\"");
        drive(&mut e, Some(Msg::Input(press("a", 0))), 0);
        let result = drive(&mut e, Some(Msg::Suspend), 0);
        assert!(result
            .iter()
            .any(|ev| ev.key == key("b") && ev.state == KeyState::Release));
    }

    #[test]
    fn drive_resume_ends_suspension() {
        let mut e = engine_with("[profile.default.keys]\na = \"b\"");
        drive(&mut e, Some(Msg::Suspend), 0);
        assert!(e.is_suspended());
        // While suspended: raw passthrough
        assert_eq!(
            drive(&mut e, Some(Msg::Input(press("a", 10))), 10),
            vec![press("a", 10)]
        );
        drive(&mut e, Some(Msg::Input(release("a", 15))), 15);
        drive(&mut e, Some(Msg::Resume), 20);
        assert!(!e.is_suspended());
        assert_eq!(
            drive(&mut e, Some(Msg::Input(press("a", 30))), 30),
            vec![press("b", 30)]
        );
    }
}
