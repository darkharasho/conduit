mod devices;
mod output;
mod paths;

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt;
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
    let settings = &compiled.settings;

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
        if devices::should_grab(d, settings) {
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
            let grab = devices::should_grab(d, settings);
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

    Ok(())
}
