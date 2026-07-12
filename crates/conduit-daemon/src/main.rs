mod devices;
mod focus;
mod hotplug;
mod output;
mod paths;
mod runloop;

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

    // Drop our (main-thread) sender now that both the hotplug thread and the
    // run loop thread hold their own clones.
    drop(tx);

    // ── Engine thread ──────────────────────────────────────────────────────────
    let engine = conduit_core::engine::Engine::new(compiled);
    let run_out = Arc::clone(&out);
    let run_thread = std::thread::spawn(move || {
        runloop::run(engine, run_out, rx, run_tx, readers, settings)
    });

    run_thread
        .join()
        .map_err(|_| anyhow::anyhow!("run loop thread panicked"))?;

    Ok(())
}
