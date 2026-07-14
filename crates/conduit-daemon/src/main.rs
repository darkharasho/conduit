//! conduit-daemon binary entry point.
//!
//! Thin wrapper: handles `--check`, permission checks, device table display,
//! then delegates to `conduit_daemon::start()` for the actual daemon threads.

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt;

use anyhow::Context;

// Re-export the library crate's modules under `mod` aliases so that the
// binary can use them without a separate crate dependency path.
use conduit_daemon::check;
use conduit_daemon::devices;
use conduit_daemon::paths;
use conduit_daemon::runloop;

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
        println!("{}", check::run_check_json(&check::CheckPaths::default()));
        return Ok(());
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

    let compiled = conduit_core::config::compile(&toml_str)
        .with_context(|| format!("parsing config at {}", config_path.display()))?;
    let settings = compiled.settings.clone();

    // ── Discover devices ──────────────────────────────────────────────────────
    let discovered = devices::discover()
        .context("enumerating input devices")?;

    // ── Supplemental EACCES check ─────────────────────────────────────────────
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
            eprintln!("  2. Install the udev rule:");
            eprintln!("       sudo cp packaging/99-conduit.rules /etc/udev/rules.d/ && \\");
            eprintln!("       sudo udevadm control --reload && sudo udevadm trigger");
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
        eprintln!("  2. Install the udev rule:");
        eprintln!("       sudo cp packaging/99-conduit.rules /etc/udev/rules.d/ && \\");
        eprintln!("       sudo udevadm control --reload && sudo udevadm trigger");
        std::process::exit(2);
    }

    // ── Print device table ────────────────────────────────────────────────────
    println!("Socket: {}", paths::socket_path().display());
    println!(
        "{:<6}  {:<12}  {:<9}  {:<10}  {}",
        "GRAB", "vendor:prod", "CLASS", "path", "name"
    );
    println!("{}", "─".repeat(70));

    if discovered.is_empty() {
        println!("  (no input devices found under /dev/input/)");
    } else {
        for d in &discovered {
            let grab = devices::should_grab(d, &settings);
            println!(
                "{:<6}  {:04x}:{:04x}  {:<9}  {:<10}  {}",
                if grab { "YES" } else { "no" },
                d.vendor,
                d.product,
                d.class.as_str(),
                d.path.display(),
                d.name,
            );
        }
    }

    // ── Start the daemon (all features enabled) ───────────────────────────────
    let handle = conduit_daemon::start(conduit_daemon::DaemonConfig {
        config_path,
        socket_path: None, // use default from paths::socket_path()
        enable_focus: true,
        enable_hotplug: true,
        enable_watch: true,
    })?;

    // Block here until the daemon is stopped externally (e.g. SIGTERM / systemd
    // stop).  Using `wait()` instead of `shutdown()` avoids sending Msg::Shutdown
    // ourselves — the daemon stays alive until all channel senders are dropped
    // or an external signal terminates the process.  Systemd Restart=on-failure
    // only fires on non-zero exit; `shutdown()` causes an immediate exit 0 which
    // systemd would NOT restart, defeating the service.
    handle.wait();

    Ok(())
}

