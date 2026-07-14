use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use crate::{find_conduit_daemon_binary, socket_path, ErrorPayload};

// ---- Constants ----

pub const SERVICE_UNIT: &str = "\
[Unit]\n\
Description=Conduit input remapping daemon\n\
\n\
[Service]\n\
ExecStart=%h/.local/bin/conduit-daemon\n\
Restart=on-failure\n\
RestartSec=1\n\
\n\
[Install]\n\
WantedBy=default.target\n";

pub const UDEV_RULE: &str =
    "KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\", OPTIONS+=\"static_node=uinput\"\n";

// ---- Pure functions ----

/// Decide whether the destination binary should be replaced by the source.
/// `src_meta`  = (size_bytes, mtime) of the freshest non-dest source candidate.
/// `dest_meta` = None if dest doesn't exist yet; Some((size, mtime)) otherwise.
/// Returns true when: dest is absent, OR source is newer, OR sizes differ.
pub fn should_replace_binary(
    src_meta: (u64, SystemTime),
    dest_meta: Option<(u64, SystemTime)>,
) -> bool {
    match dest_meta {
        None => true,
        Some((dest_size, dest_mtime)) => {
            let (src_size, src_mtime) = src_meta;
            if src_size != dest_size {
                return true;
            }
            // src newer → replace; src older or equal → keep
            src_mtime > dest_mtime
        }
    }
}

/// Validate a Unix username against [a-z_][a-z0-9_-]*.
/// Returns Err(msg) if invalid.
pub fn fix_permissions_script_checked(user: &str) -> Result<String, String> {
    // Validate: must match [a-z_][a-z0-9_-]*
    if user.is_empty() {
        return Err(format!("invalid username: {:?}", user));
    }
    let mut chars = user.chars();
    let first = chars.next().unwrap();
    if !matches!(first, 'a'..='z' | '_') {
        return Err(format!("invalid username: {:?}", user));
    }
    for c in chars {
        if !matches!(c, 'a'..='z' | '0'..='9' | '_' | '-') {
            return Err(format!("invalid username: {:?}", user));
        }
    }

    // Build the script that runs under pkexec — never invokes pkexec itself
    let script = format!(
        "set -e\n\
mkdir -p /etc/udev/rules.d\n\
printf '%s' '{rule}' > /etc/udev/rules.d/99-conduit.rules\n\
udevadm control --reload\n\
udevadm trigger\n\
usermod -aG input {user}\n",
        rule = UDEV_RULE,
        user = user,
    );
    Ok(script)
}


/// Assemble a multi-section diagnostic report.
/// Each section is rendered as:
///   == {title} ==\n{body}\n\n
pub fn assemble_report(sections: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (title, body) in sections {
        out.push_str(&format!("== {} ==\n{}\n\n", title, body));
    }
    out
}

// ---- Response types ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SetupStatus {
    pub service_installed: bool,
    pub service_running: bool,
    pub daemon_connected: bool,
    pub uinput_ok: bool,
    pub evdev_ok: bool,
    pub input_group: bool,
    pub config_ok: bool,
    pub binary_missing: bool,
    pub binary_path: Option<String>,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionFixOutcome {
    pub relogin_needed: bool,
}

// ---- Helper: run a process and capture stdout+stderr ----

fn run_capture(cmd: &str, args: &[&str]) -> (bool, String, String) {
    match std::process::Command::new(cmd).args(args).output() {
        Ok(out) => {
            let success = out.status.success();
            let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
            let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
            (success, stdout, stderr)
        }
        Err(e) => (false, String::new(), e.to_string()),
    }
}

// ---- Tauri commands ----

/// Detailed status probe — uses --check output + systemd + socket probe.
#[tauri::command]
pub async fn setup_status() -> Result<SetupStatus, ErrorPayload> {
    let mut details: Vec<String> = Vec::new();

    // 1. Is the daemon socket reachable?
    let daemon_connected = UnixStream::connect(socket_path()).is_ok();

    // 2. Is the systemd user service installed?
    let service_unit_path = service_unit_path();
    let service_installed = service_unit_path.exists();

    // 3. Is the service running?
    let (running_ok, running_out, _running_err) =
        run_capture("systemctl", &["--user", "is-active", "conduit.service"]);
    let service_running = running_ok;
    details.push(format!(
        "systemctl --user is-active: {}",
        running_out.trim()
    ));

    // 4. Find binary and run --check
    let binary = find_conduit_daemon_binary();
    let (binary_missing, binary_path, uinput_ok, evdev_ok, input_group, config_ok) =
        if let Some(ref bp) = binary {
            let bp_str = bp.to_string_lossy().into_owned();
            let output = std::process::Command::new(bp)
                .arg("--check")
                .output();
            match output {
                Ok(out) => {
                    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
                    details.push(format!("--check stdout: {}", stdout.trim()));
                    let check: DaemonCheckOutput =
                        serde_json::from_str(stdout.trim()).unwrap_or_default();
                    (false, Some(bp_str), check.uinput, check.evdev, check.input_group, check.config_ok)
                }
                Err(e) => {
                    details.push(format!("--check failed: {}", e));
                    (false, Some(bp_str), false, false, false, false)
                }
            }
        } else {
            details.push("conduit-daemon binary not found".to_string());
            (true, None, false, false, false, false)
        };

    Ok(SetupStatus {
        service_installed,
        service_running,
        daemon_connected,
        uinput_ok,
        evdev_ok,
        input_group,
        config_ok,
        binary_missing,
        binary_path,
        details,
    })
}

/// Install conduit-daemon to ~/.local/bin and set up the systemd user service.
#[tauri::command]
pub async fn setup_install_service() -> Result<(), ErrorPayload> {
    let home = std::env::var("HOME")
        .map_err(|_| ErrorPayload::new("internal", "HOME not set", ""))?;
    let home = PathBuf::from(home);

    // Ensure ~/.local/bin exists
    let local_bin = home.join(".local").join("bin");
    std::fs::create_dir_all(&local_bin).map_err(|e| {
        ErrorPayload::new("internal", "failed to create ~/.local/bin", e.to_string())
    })?;

    let dest = local_bin.join("conduit-daemon");

    // Copy binary using copy-if-stale logic:
    // Find the freshest source that is NOT the destination itself.
    let src_opt = find_conduit_daemon_binary_excluding(&dest);

    if let Some(src) = src_opt {
        // Gather metadata for staleness check
        let src_meta_raw = std::fs::metadata(&src);
        let dest_meta_raw = std::fs::metadata(&dest);

        let src_meta: Option<(u64, SystemTime)> = src_meta_raw.ok().and_then(|m| {
            m.modified().ok().map(|t| (m.len(), t))
        });

        let dest_meta: Option<(u64, SystemTime)> = dest_meta_raw.ok().and_then(|m| {
            m.modified().ok().map(|t| (m.len(), t))
        });

        let do_copy = match src_meta {
            None => !dest.exists(), // can't read src meta: only copy if dest absent
            Some(sm) => should_replace_binary(sm, dest_meta),
        };

        if do_copy {
            std::fs::copy(&src, &dest).map_err(|e| {
                ErrorPayload::new(
                    "internal",
                    "failed to copy conduit-daemon to ~/.local/bin",
                    e.to_string(),
                )
            })?;
            // Make it executable
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&dest)
                .map_err(|e| ErrorPayload::new("internal", "failed to read permissions", e.to_string()))?
                .permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&dest, perms).map_err(|e| {
                ErrorPayload::new("internal", "failed to set permissions", e.to_string())
            })?;
        }
    } else if !dest.exists() {
        // No source other than dest, and dest is also absent — hard error.
        return Err(ErrorPayload::new(
            "internal",
            "Conduit's engine program is missing from this build",
            "",
        ));
    }
    // else: no source other than dest, but dest already exists — keep it as-is.

    // Write the unit file
    let unit_dir = home.join(".config").join("systemd").join("user");
    std::fs::create_dir_all(&unit_dir).map_err(|e| {
        ErrorPayload::new(
            "internal",
            "failed to create ~/.config/systemd/user",
            e.to_string(),
        )
    })?;
    let unit_path = unit_dir.join("conduit.service");
    std::fs::write(&unit_path, SERVICE_UNIT).map_err(|e| {
        ErrorPayload::new("internal", "failed to write conduit.service", e.to_string())
    })?;

    // systemctl --user daemon-reload
    let out = std::process::Command::new("systemctl")
        .args(["--user", "daemon-reload"])
        .output()
        .map_err(|e| ErrorPayload::new("internal", "failed to run systemctl daemon-reload", e.to_string()))?;
    if !out.status.success() {
        return Err(ErrorPayload::new(
            "internal",
            "systemctl daemon-reload failed",
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }

    // systemctl --user enable --now conduit.service
    let out = std::process::Command::new("systemctl")
        .args(["--user", "enable", "--now", "conduit.service"])
        .output()
        .map_err(|e| {
            ErrorPayload::new(
                "internal",
                "failed to run systemctl enable --now",
                e.to_string(),
            )
        })?;
    if !out.status.success() {
        return Err(ErrorPayload::new(
            "internal",
            "systemctl enable --now failed",
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }

    Ok(())
}

/// Run the udev + usermod fix script under pkexec in one prompt.
#[tauri::command]
pub async fn setup_fix_permissions() -> Result<PermissionFixOutcome, ErrorPayload> {
    // Get current username
    let who_out = std::process::Command::new("whoami")
        .output()
        .map_err(|e| ErrorPayload::new("internal", "failed to run whoami", e.to_string()))?;
    let username = String::from_utf8_lossy(&who_out.stdout).trim().to_string();

    let script = fix_permissions_script_checked(&username)
        .map_err(|e| ErrorPayload::new("internal", "invalid username from whoami", e))?;

    // Run the whole script as root in one pkexec prompt
    let out = std::process::Command::new("pkexec")
        .args(["sh", "-c", &script])
        .output()
        .map_err(|e| ErrorPayload::new("internal", "failed to run pkexec", e.to_string()))?;

    let exit_code = out.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

    // 126 = auth cancelled, 127 = not authorized / polkit not found
    if exit_code == 126 || exit_code == 127 {
        return Err(ErrorPayload::new(
            "permission-denied",
            "You closed the password prompt",
            stderr,
        ));
    }

    if !out.status.success() {
        return Err(ErrorPayload::new(
            "internal",
            "permission fix script failed",
            stderr,
        ));
    }

    // Determine if a re-login is needed: check if current process groups include "input"
    let in_input_group = std::process::Command::new("id")
        .arg("-Gn")
        .output()
        .map(|o| {
            let groups = String::from_utf8_lossy(&o.stdout).into_owned();
            groups.split_whitespace().any(|g| g == "input")
        })
        .unwrap_or(false);
    // usermod ran (script succeeded) and we're not yet in the group → relogin needed
    let relogin_needed = !in_input_group;

    Ok(PermissionFixOutcome { relogin_needed })
}

/// Restart the conduit systemd user service.
#[tauri::command]
pub async fn restart_engine() -> Result<(), ErrorPayload> {
    let out = std::process::Command::new("systemctl")
        .args(["--user", "restart", "conduit.service"])
        .output()
        .map_err(|e| {
            ErrorPayload::new("internal", "failed to run systemctl restart", e.to_string())
        })?;
    if !out.status.success() {
        return Err(ErrorPayload::new(
            "internal",
            "systemctl restart failed",
            String::from_utf8_lossy(&out.stderr).to_string(),
        ));
    }
    Ok(())
}

/// Collect a diagnostic report from all available sources.
#[tauri::command]
pub async fn collect_report() -> Result<String, ErrorPayload> {
    let mut sections: Vec<(&str, String)> = Vec::new();

    // Section: --check output
    let check_body = if let Some(binary) = find_conduit_daemon_binary() {
        match std::process::Command::new(&binary).arg("--check").output() {
            Ok(out) => {
                let mut body = String::from_utf8_lossy(&out.stdout).into_owned();
                let err = String::from_utf8_lossy(&out.stderr);
                if !err.trim().is_empty() {
                    body.push_str(&format!("\nstderr: {}", err));
                }
                body
            }
            Err(e) => format!("error: {}", e),
        }
    } else {
        "conduit-daemon binary not found".to_string()
    };
    sections.push(("check", check_body));

    // Section: service status
    let (_ok, status_out, status_err) = run_capture(
        "systemctl",
        &["--user", "status", "conduit.service", "-n", "0"],
    );
    let service_body = if status_err.trim().is_empty() {
        status_out
    } else {
        format!("{}\nstderr: {}", status_out, status_err)
    };
    sections.push(("service", service_body));

    // Section: journal
    let (_ok, journal_out, journal_err) = run_capture(
        "journalctl",
        &["--user", "-u", "conduit.service", "-n", "50", "--no-pager"],
    );
    let journal_body = if journal_err.trim().is_empty() {
        journal_out
    } else {
        format!("{}\nstderr: {}", journal_out, journal_err)
    };
    sections.push(("journal", journal_body));

    // Section: versions
    let app_version = env!("CARGO_PKG_VERSION");
    let daemon_version = if let Some(binary) = find_conduit_daemon_binary() {
        match std::process::Command::new(&binary).arg("--version").output() {
            Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
            Err(e) => format!("error: {}", e),
        }
    } else {
        "not found".to_string()
    };
    let versions_body = format!("app: {}\ndaemon: {}", app_version, daemon_version);
    sections.push(("versions", versions_body));

    // Build the report using owned strings as slices
    let slice_sections: Vec<(&str, &str)> = sections
        .iter()
        .map(|(t, b)| (*t, b.as_str()))
        .collect();

    Ok(assemble_report(&slice_sections))
}

// ---- Helpers ----

/// Like `find_conduit_daemon_binary`, but skips `exclude` so the resolver
/// doesn't return dest as its own source (which would make every run a no-op).
fn find_conduit_daemon_binary_excluding(exclude: &std::path::Path) -> Option<PathBuf> {
    // Collect every candidate from the standard resolver by walking through
    // the same priority list, skipping the one that equals `exclude`.
    // We re-implement the search inline to be able to skip mid-list.

    // 1. PATH via `which`
    if let Ok(output) = std::process::Command::new("which").arg("conduit-daemon").output() {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout);
            let path = path.trim();
            if !path.is_empty() {
                let pb = PathBuf::from(path);
                if pb != exclude {
                    return Some(pb);
                }
            }
        }
    }

    // 2. ~/.local/bin/conduit-daemon — this IS usually the dest; skip if so
    if let Ok(home) = std::env::var("HOME") {
        let candidate = PathBuf::from(home).join(".local").join("bin").join("conduit-daemon");
        if candidate.exists() && candidate != exclude {
            return Some(candidate);
        }
    }

    // 3 & 4. Relative to the app executable (dev mode)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let sibling = exe_dir.join("conduit-daemon");
            if sibling.exists() && sibling != exclude {
                return Some(sibling);
            }
            for profile in &["debug", "release"] {
                let candidate = exe_dir
                    .parent()
                    .and_then(|p| p.parent())
                    .map(|root| root.join("target").join(profile).join("conduit-daemon"));
                if let Some(c) = candidate {
                    if c.exists() && c != exclude {
                        return Some(c);
                    }
                }
            }
        }
    }

    None
}

fn service_unit_path() -> PathBuf {
    let config_dir = std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".config"))
        .unwrap_or_else(|_| PathBuf::from("/nonexistent"));
    config_dir.join("systemd").join("user").join("conduit.service")
}

// ---- Serde helpers ----

#[derive(Debug, Default, Serialize, Deserialize)]
struct DaemonCheckOutput {
    #[serde(default)]
    uinput: bool,
    #[serde(default)]
    evdev: bool,
    #[serde(default)]
    input_group: bool,
    #[serde(default)]
    config_ok: bool,
}

// ---- Tests ----

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_and_rule_match_packaging_files() {
        let unit = std::fs::read_to_string(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../packaging/conduit.service")).unwrap();
        assert_eq!(SERVICE_UNIT, unit);
        let rule = std::fs::read_to_string(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../packaging/99-conduit.rules")).unwrap();
        assert!(rule.ends_with(UDEV_RULE), "packaging rule must end with the KERNEL line");
    }

    #[test]
    fn fix_script_is_single_prompt_batch_and_validates_user() {
        let s = fix_permissions_script_checked("mstephens").unwrap();
        assert!(s.starts_with("set -e\n"));
        assert!(s.contains("/etc/udev/rules.d/99-conduit.rules"));
        assert!(s.contains("udevadm control --reload"));
        assert!(s.contains("usermod -aG input mstephens"));
        assert!(!s.contains("pkexec"), "script runs UNDER pkexec, never invokes it");
    }

    #[test]
    fn fix_script_rejects_hostile_usernames() {
        assert!(fix_permissions_script_checked("evil; rm -rf /").is_err());
        assert!(fix_permissions_script_checked("root$(cmd)").is_err());
        assert!(fix_permissions_script_checked("").is_err());
        assert!(fix_permissions_script_checked("1startdigit").is_err());
        // valid usernames should pass
        assert!(fix_permissions_script_checked("mstephens").is_ok());
        assert!(fix_permissions_script_checked("_sysuser").is_ok());
        assert!(fix_permissions_script_checked("user-name").is_ok());
        assert!(fix_permissions_script_checked("user123").is_ok());
    }

    #[test]
    fn report_sections_are_titled() {
        let r = assemble_report(&[("check", "{}"), ("journal", "line1\nline2")]);
        assert!(r.contains("== check ==\n{}"));
        assert!(r.contains("== journal ==\nline1\nline2"));
    }

    // ---- should_replace_binary unit tests ----

    fn ts(secs: u64) -> SystemTime {
        // Build a deterministic SystemTime from UNIX_EPOCH + secs.
        SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(secs)
    }

    #[test]
    fn replace_binary_dest_absent() {
        // dest None → always replace
        assert!(should_replace_binary((1024, ts(100)), None));
    }

    #[test]
    fn replace_binary_src_newer() {
        // src mtime newer than dest → replace
        assert!(should_replace_binary(
            (1024, ts(200)),
            Some((1024, ts(100))),
        ));
    }

    #[test]
    fn replace_binary_same_size_and_mtime() {
        // identical size + mtime → keep (no-op)
        assert!(!should_replace_binary(
            (1024, ts(100)),
            Some((1024, ts(100))),
        ));
    }

    #[test]
    fn replace_binary_src_older_but_different_size() {
        // src older but different size → replace
        assert!(should_replace_binary(
            (2048, ts(50)),
            Some((1024, ts(100))),
        ));
    }
}
