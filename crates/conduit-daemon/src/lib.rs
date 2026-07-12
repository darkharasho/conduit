//! conduit-daemon as a library.
//!
//! Exposes the daemon modules and a `start()` function that launches the daemon
//! in background threads. The returned `DaemonHandle` owns the thread handles
//! and a shutdown sender; calling `shutdown()` stops the daemon.
//!
//! Used by integration tests to drive the real daemon as a library rather than
//! as a subprocess.

pub mod devices;
pub mod focus;
pub mod hotplug;
pub mod ipc;
pub mod output;
pub mod paths;
pub mod runloop;
pub mod watch;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use anyhow::Context;
use crossbeam_channel::Sender;

use conduit_core::config;

/// Configuration for the daemon library entry point.
pub struct DaemonConfig {
    /// Path to the TOML config file (must exist and be valid).
    pub config_path: PathBuf,
    /// Override the socket path; `None` uses `paths::socket_path()`.
    pub socket_path: Option<PathBuf>,
    /// Enable focus-tracking (Hyprland/X11). Disable in tests.
    pub enable_focus: bool,
    /// Enable udev hotplug monitoring. Disable in tests.
    pub enable_hotplug: bool,
    /// Enable config file watch. Disable in tests.
    pub enable_watch: bool,
}

/// Handle to a running daemon instance.
///
/// Dropping this handle does NOT stop the daemon — call `shutdown()` to perform
/// a clean shutdown, or simply drop it if the process is exiting.
pub struct DaemonHandle {
    /// Sending on this causes no direct effect; dropping it decrements the
    /// sender count.  When all senders (including those held by hotplug/focus/
    /// IPC/watch threads) are dropped the run loop's `rx.recv()` returns
    /// `Disconnected`, which causes `runloop::run` to return.
    _shutdown_tx: Sender<runloop::Msg>,
    run_thread: Option<std::thread::JoinHandle<()>>,
    /// Threads that are difficult to join promptly (e.g. hotplug is blocked in
    /// a udev poll loop; IPC accept loop is blocked in `listener.incoming()`).
    /// We detach these on shutdown — the OS will clean them up on process exit.
    _detached_threads: Vec<std::thread::JoinHandle<()>>,
}

impl DaemonHandle {
    /// Shut the daemon down.
    ///
    /// Sends `Msg::Shutdown` to the run loop (causes it to exit immediately),
    /// then joins the run-loop thread.
    ///
    /// Note: the hotplug thread is blocked in a udev `iter()` / sleep loop and
    /// the IPC accept thread is blocked in `listener.incoming()`.  Neither
    /// can be joined promptly, so both are detached (the OS reclaims them on
    /// process exit, and in tests the process exits quickly after the test
    /// completes).
    pub fn shutdown(mut self) {
        // Send the shutdown signal.  If the channel is already closed (run loop
        // has exited on its own) this is a no-op.
        let _ = self._shutdown_tx.send(crate::runloop::Msg::Shutdown);
        // Join the run-loop thread (it exits promptly after receiving Shutdown).
        if let Some(h) = self.run_thread.take() {
            let _ = h.join();
        }
        // Everything else (_shutdown_tx, _detached_threads) drops here.
        // The detached threads (IPC accept, hotplug) cannot be joined promptly;
        // dropping their handles detaches them and the OS reclaims them.
    }

    /// Return a `Sender` that can inject messages directly into the run loop.
    ///
    /// Intended for integration tests: the test can send `Msg::Input` events
    /// to the daemon without going through the Linux evdev input stack.  This
    /// works regardless of whether EVIOCGRAB is supported on the test device.
    ///
    /// Callers must import `conduit_daemon::runloop::Msg` to construct events.
    pub fn msg_tx(&self) -> Sender<runloop::Msg> {
        self._shutdown_tx.clone()
    }
}

/// Start the daemon as library threads.
///
/// Reads and compiles `config.config_path`, discovers devices, creates the
/// virtual output, grabs matching devices, and spawns the run loop plus
/// optional hotplug / focus / watch / IPC threads.
///
/// Returns a `DaemonHandle` that holds the sender and thread handles.
pub fn start(config: DaemonConfig) -> anyhow::Result<DaemonHandle> {
    let _ = runloop::now_us(); // pin time base

    let toml_str = std::fs::read_to_string(&config.config_path)
        .with_context(|| format!("reading config at {}", config.config_path.display()))?;

    let compiled = config::compile(&toml_str)
        .with_context(|| format!("parsing config at {}", config.config_path.display()))?;
    let settings = compiled.settings.clone();

    // Discover devices and grab matching ones.
    let discovered = devices::discover().context("enumerating input devices")?;

    // Create virtual output.
    let out = Arc::new(Mutex::new(
        output::VirtualOutput::new().context("creating virtual output devices")?,
    ));

    // Channel for all daemon messages.
    let (tx, rx) = crossbeam_channel::unbounded::<runloop::Msg>();

    // Grab matching devices and spawn reader threads.
    let mut readers: HashMap<PathBuf, devices::GrabHandle> = HashMap::new();
    for d in &discovered {
        if devices::should_grab(d, &settings) {
            let handle = devices::spawn_reader(
                d.path.clone(),
                d.is_mouse,
                true, // always grab in production
                tx.clone(),
                Arc::clone(&out),
            );
            readers.insert(d.path.clone(), handle);
        }
    }

    let mut detached: Vec<std::thread::JoinHandle<()>> = Vec::new();

    // Optional hotplug monitor.
    if config.enable_hotplug {
        let h = hotplug::spawn(tx.clone());
        detached.push(h);
    }

    // Optional focus watcher.
    if config.enable_focus {
        if let Some(backend) = focus::detect() {
            let focus_tx = tx.clone();
            let h = std::thread::Builder::new()
                .name("conduit-focus".into())
                .spawn(move || backend.run(focus_tx))
                .expect("spawning focus thread");
            detached.push(h);
        }
    }

    // Shared reload gate.
    let gate = {
        let mut g = watch::ReloadGate::new();
        g.record(&toml_str);
        Arc::new(Mutex::new(g))
    };

    // IPC server.
    let sock_path = config
        .socket_path
        .unwrap_or_else(paths::socket_path);
    let ipc_thread = ipc::spawn_at(sock_path, tx.clone(), config.config_path.clone(), Arc::clone(&gate))
        .context("spawning IPC server")?;
    detached.push(ipc_thread);

    // Optional config file watcher.
    if config.enable_watch {
        let h = watch::spawn(config.config_path.clone(), tx.clone(), Arc::clone(&gate));
        detached.push(h);
    }

    // Clone tx for the run loop (so readers spawned on hotplug can send back).
    let run_tx = tx.clone();

    // The shutdown_tx is the caller's handle; when it is dropped, if all
    // other senders are also gone the run loop exits.
    let shutdown_tx = tx;

    let run_out = Arc::clone(&out);
    let run_thread = std::thread::Builder::new()
        .name("conduit-runloop".into())
        .spawn(move || {
            runloop::run(
                conduit_core::engine::Engine::new(compiled),
                Some(run_out),
                rx,
                run_tx,
                readers,
                settings,
            )
        })
        .context("spawning run loop thread")?;

    Ok(DaemonHandle {
        _shutdown_tx: shutdown_tx,
        run_thread: Some(run_thread),
        _detached_threads: detached,
    })
}
