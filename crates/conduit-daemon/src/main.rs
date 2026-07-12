mod devices;
mod focus;
mod hotplug;
mod ipc;
mod output;
mod paths;
mod runloop;
mod watch;

use std::collections::HashMap;
use std::fs;
use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use anyhow::Context;
use conduit_core::config;

/// Default config file contents (all active settings as comments).
const DEFAULT_CONFIG: &str = r#"# conduit.toml — Conduit keyboard remapper configuration
# This file was created automatically. Edit it to configure Conduit.

[settings]
# tap_hold_timeout = 200   # milliseconds; default: 200
# panic_chord = ["leftctrl", "leftalt", "backspace"]

[devices]
# Grab every keyboard found on the system:
# grab_all_keyboards = false

# Or grab only specific keyboards by exact device name:
# grab_keyboards = []

# Grab specific mice by exact device name:
# grab_mice = []

# [profile.default.keys]
# capslock = { tap = "esc", hold = "leftctrl" }
"#;

fn main() -> anyhow::Result<()> {
    // ── --check flag: print JSON permission + config diagnostics and exit 0 ────
    // The Tauri UI (Task 20) uses this for first-run setup guidance.
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(|s| s.as_str()) == Some("--check") {
        return run_check();
    }

    // Pin the monotonic time base before any thread reads it.
    let _ = runloop::now_us();

    // ── Load (or create) config ───────────────────────────────────────────────
    let config_path = paths::config_path();

    let toml_str = if config_path.exists() {
        fs::read_to_string(&config_path)
            .with_context(|| format!("reading config at {}", config_path.display()))?
    } else {
        // Create parent directory and write a commented default config.
        if let Some(parent) = config_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("creating config directory {}", parent.display()))?;
        }
        // Write atomically: write to a .tmp file in the same directory, then
        // rename into place so a crash mid-write never leaves a partial file.
        let tmp_path = config_path.with_extension("toml.tmp");
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .open(&tmp_path)
                .with_context(|| format!("opening temp file {}", tmp_path.display()))?;
            f.write_all(DEFAULT_CONFIG.as_bytes())
                .with_context(|| format!("writing to temp file {}", tmp_path.display()))?;
            f.flush()
                .with_context(|| format!("flushing temp file {}", tmp_path.display()))?;
        }
        fs::rename(&tmp_path, &config_path)
            .with_context(|| format!("renaming {} to {}", tmp_path.display(), config_path.display()))?;
        eprintln!(
            "conduit: created default config at {}",
            config_path.display()
        );
        DEFAULT_CONFIG.to_string()
    };

    let compiled = config::compile(&toml_str)
        .with_context(|| format!("parsing config at {}", config_path.display()))?;
    let settings = compiled.settings.clone();

    // ── Discover devices ──────────────────────────────────────────────────────
    let discovered = devices::discover()
        .context("enumerating input devices")?;

    // ── Supplemental EACCES check ─────────────────────────────────────────────
    // evdev::enumerate() silently skips devices it cannot open, so if the user
    // has no access to /dev/input the discovery list is empty with no error.
    // Detect this: when discovery found nothing, probe /dev/input/event* directly
    // and check for EACCES so we can emit an actionable message.
    {
        let eacces_blocked = devices::eacces_blocked_event_nodes();
        if devices::should_fail_eacces(discovered.len(), eacces_blocked.len()) {
            eprintln!("conduit: no input devices discovered.");
            eprintln!(
                "conduit: {} /dev/input/event* node(s) are blocked by permission errors:",
                eacces_blocked.len()
            );
            for p in &eacces_blocked {
                eprintln!("  {}", p.display());
            }
            eprintln!();
            eprintln!("conduit: ACTION REQUIRED — fix input device permissions:");
            eprintln!("  1. Add your user to the 'input' group:");
            eprintln!("       sudo usermod -aG input $USER");
            eprintln!("     then log out and back in (or run: newgrp input).");
            eprintln!("  2. A udev rule will be installed by the conduit package (Task 15).");
            eprintln!("     For now you can create /etc/udev/rules.d/99-conduit.rules:");
            eprintln!("       KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\"");
            eprintln!("       SUBSYSTEM==\"input\", GROUP=\"input\", MODE=\"0660\"");
            eprintln!("     then run: sudo udevadm control --reload-rules && sudo udevadm trigger");
            std::process::exit(2);
        }
    }

    // ── Permission check: try opening any device we would grab ────────────────
    let mut perm_error = false;
    for d in &discovered {
        if devices::should_grab(d, &settings) {
            match fs::OpenOptions::new()
                .read(true)
                .custom_flags(nix::libc::O_NONBLOCK)
                .open(&d.path)
            {
                Err(e) if e.raw_os_error() == Some(nix::libc::EACCES) => {
                    eprintln!(
                        "conduit: permission denied opening {} ({})",
                        d.path.display(),
                        d.name
                    );
                    perm_error = true;
                }
                _ => {}
            }
        }
    }

    // Check /dev/uinput
    match fs::OpenOptions::new()
        .write(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open("/dev/uinput")
    {
        Err(e) if e.raw_os_error() == Some(nix::libc::EACCES) => {
            eprintln!("conduit: permission denied opening /dev/uinput");
            perm_error = true;
        }
        Err(e) if e.raw_os_error() == Some(nix::libc::ENOENT) => {
            eprintln!("conduit: /dev/uinput not found — is the uinput kernel module loaded?");
            perm_error = true;
        }
        _ => {}
    }

    if perm_error {
        eprintln!();
        eprintln!("conduit: ACTION REQUIRED — fix input device permissions:");
        eprintln!("  1. Add your user to the 'input' group:");
        eprintln!("       sudo usermod -aG input $USER");
        eprintln!("     then log out and back in (or run: newgrp input).");
        eprintln!("  2. A udev rule will be installed by the conduit package (Task 15).");
        eprintln!("     For now you can create /etc/udev/rules.d/99-conduit.rules:");
        eprintln!("       KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\"");
        eprintln!("       SUBSYSTEM==\"input\", GROUP=\"input\", MODE=\"0660\"");
        eprintln!("     then run: sudo udevadm control --reload-rules && sudo udevadm trigger");
        std::process::exit(2);
    }

    // ── Print device table ────────────────────────────────────────────────────
    println!("Socket: {}", paths::socket_path().display());
    println!(
        "{:<6}  {:<12}  {:<4}  {:<5}  {:<10}  {}",
        "GRAB", "vendor:prod", "KBD?", "MOUSE", "path", "name"
    );
    println!("{}", "─".repeat(70));

    if discovered.is_empty() {
        println!("  (no input devices found under /dev/input/)");
    } else {
        for d in &discovered {
            let grab = devices::should_grab(d, &settings);
            println!(
                "{:<6}  {:04x}:{:04x}  {:<4}  {:<5}  {:<10}  {}",
                if grab { "YES" } else { "no" },
                d.vendor,
                d.product,
                if d.is_keyboard { "yes" } else { "no" },
                if d.is_mouse { "yes" } else { "no" },
                d.path.display(),
                d.name,
            );
        }
    }

    // ── Create virtual output BEFORE grabbing (spec safety requirement) ──────
    // If uinput setup fails we must not be holding any grabs, or the user
    // would lose their keyboard with no way to type.
    let out = Arc::new(Mutex::new(
        output::VirtualOutput::new().context("creating virtual output devices")?,
    ));

    // ── Grab matching devices and spawn reader threads ────────────────────────
    let (tx, rx) = crossbeam_channel::unbounded::<runloop::Msg>();
    let mut readers: HashMap<PathBuf, devices::GrabHandle> = HashMap::new();
    for d in &discovered {
        if devices::should_grab(d, &settings) {
            let handle =
                devices::spawn_reader(d.path.clone(), d.is_mouse, tx.clone(), Arc::clone(&out));
            readers.insert(d.path.clone(), handle);
        }
    }
    if readers.is_empty() {
        eprintln!("conduit: no devices matched the grab rules; waiting for hotplug");
    }

    // ── Hotplug monitor thread ─────────────────────────────────────────────────
    // The hotplug thread holds a tx clone which keeps the run loop alive even
    // when no devices are currently grabbed.  Spawn it BEFORE dropping our own
    // tx so the run loop is never left with zero senders.
    let _hotplug_thread = hotplug::spawn(tx.clone());

    // ── Focus watcher thread ───────────────────────────────────────────────────
    // Autodetect the display environment (Hyprland → X11 → None) and spawn a
    // background thread that streams Msg::Focus events to the run loop.
    // If no backend is available the daemon runs with the default profile only.
    let _focus_thread = focus::detect().map(|backend| {
        let focus_tx = tx.clone();
        std::thread::Builder::new()
            .name("conduit-focus".into())
            .spawn(move || backend.run(focus_tx))
            .expect("spawning focus thread")
    });

    // Clone a sender for the run loop (used to give newly-spawned reader
    // threads a way to send DeviceRemoved back to the engine).
    let run_tx = tx.clone();

    // ── Shared reload gate (IPC ↔ watch deduplication) ────────────────────────
    // Both the IPC set_config handler and the watch thread share this gate so
    // that a set_config write does not cause a redundant second Msg::Reload.
    // Seed it with the content that was already compiled at startup so the
    // watcher does not immediately re-fire on the initial mtime.
    let gate = {
        let mut g = watch::ReloadGate::new();
        g.record(&toml_str);
        std::sync::Arc::new(std::sync::Mutex::new(g))
    };

    // ── IPC server thread ──────────────────────────────────────────────────────
    // Spawn before dropping our own tx so the run loop is never left with zero
    // senders.  The join handle is kept alive for the process lifetime.
    let _ipc_thread = ipc::spawn(tx.clone(), config_path.clone(), std::sync::Arc::clone(&gate))
        .context("spawning IPC server")?;

    // ── Config file watcher thread ─────────────────────────────────────────────
    // Polls the config file mtime every 500 ms; on change compiles and sends
    // Msg::Reload.  Shares `gate` with the IPC thread to avoid double-reloads
    // from set_config writes.
    let _watch_thread = watch::spawn(config_path.clone(), tx.clone(), std::sync::Arc::clone(&gate));

    // Drop our (main-thread) sender now that the hotplug, focus, and IPC
    // threads all hold their own clones.
    drop(tx);

    // ── Engine thread ──────────────────────────────────────────────────────────
    let engine = conduit_core::engine::Engine::new(compiled);
    let run_out = Arc::clone(&out);
    let run_thread = std::thread::spawn(move || {
        runloop::run(engine, Some(run_out), rx, run_tx, readers, settings)
    });

    run_thread
        .join()
        .map_err(|_| anyhow::anyhow!("run loop thread panicked"))?;

    Ok(())
}

// ── --check mode ──────────────────────────────────────────────────────────────

/// Print JSON startup diagnostics and exit 0.
///
/// Output: `{"uinput": bool, "input_group": bool, "config_ok": bool}`
///
/// - `uinput`: whether `/dev/uinput` can be opened for write (O_NONBLOCK).
/// - `input_group`: whether the current process is a member of the `input`
///   group (by GID lookup; the group must exist).
/// - `config_ok`: whether the current config file parses and compiles without
///   error. True also if the config file does not yet exist (the default config
///   is always valid).
///
/// Always exits 0 so the UI can consume the JSON regardless of permission
/// state.  A non-zero exit would prevent the UI from receiving any output.
fn run_check() -> anyhow::Result<()> {
    let uinput_ok = fs::OpenOptions::new()
        .write(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open("/dev/uinput")
        .is_ok();

    let input_group_ok = check_input_group();

    let config_path = paths::config_path();
    let config_ok = if config_path.exists() {
        match fs::read_to_string(&config_path) {
            Ok(toml_str) => config::compile(&toml_str).is_ok(),
            Err(_) => false,
        }
    } else {
        // No config file yet; the default will be used — always valid.
        true
    };

    // Print as a single JSON line with no trailing newline issues.
    println!(
        "{{\"uinput\":{},\"input_group\":{},\"config_ok\":{}}}",
        uinput_ok, input_group_ok, config_ok
    );

    Ok(())
}

/// Returns `true` if the calling process belongs to the `input` group.
fn check_input_group() -> bool {
    // Look up the numeric GID of the "input" group.
    let input_gid = match nix::unistd::Group::from_name("input") {
        Ok(Some(g)) => g.gid,
        _ => return false, // group doesn't exist on this system
    };

    // Check the supplementary group list.
    match nix::unistd::getgroups() {
        Ok(groups) => groups.contains(&input_gid),
        Err(_) => false,
    }
}
