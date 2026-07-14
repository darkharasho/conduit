//! Capability-based startup diagnostic for `--check`.
//!
//! Probes whether the current process can actually open the devices it needs
//! (uinput for output, evdev event nodes for input) rather than relying solely
//! on group membership.  On logind-ACL systems the user has access without
//! belonging to the `input` group, so group membership is retained only as a
//! remediation hint.

use std::os::unix::fs::OpenOptionsExt as _;
use std::path::PathBuf;

/// Paths used by the capability probe.  The defaults point at the real Linux
/// device nodes, but tests can substitute temp-dir paths.
pub struct CheckPaths {
    /// Path to `/dev/uinput` (or a substitute for testing).
    pub uinput: PathBuf,
    /// Directory scanned for `event*` nodes (normally `/dev/input`).
    pub input_dir: PathBuf,
    /// Config file path; missing = ok, present but unreadable/invalid = not ok.
    pub config: PathBuf,
}

impl Default for CheckPaths {
    fn default() -> Self {
        Self {
            uinput: PathBuf::from("/dev/uinput"),
            input_dir: PathBuf::from("/dev/input"),
            config: crate::paths::config_path(),
        }
    }
}

/// Probe whether at least one `event*` node in `input_dir` is openable for
/// reading (O_RDONLY | O_NONBLOCK).  Returns `false` if the directory is
/// empty, contains no `event*` entries, or all opens fail.
fn evdev_ok(input_dir: &std::path::Path) -> bool {
    let rd = match std::fs::read_dir(input_dir) {
        Ok(rd) => rd,
        Err(_) => return false,
    };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if !name_str.starts_with("event") {
            continue;
        }
        let path = entry.path();
        let ok = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(nix::libc::O_NONBLOCK)
            .open(&path)
            .is_ok();
        if ok {
            return true;
        }
    }
    false
}

/// Probe whether `/dev/uinput` (or the given substitute) is openable for
/// writing (O_WRONLY | O_NONBLOCK).
fn uinput_ok(uinput: &std::path::Path) -> bool {
    std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(nix::libc::O_NONBLOCK)
        .open(uinput)
        .is_ok()
}

/// Returns `true` if the calling process belongs to the `input` group.
/// Retained as a remediation hint even on logind-ACL systems.
pub fn check_input_group() -> bool {
    let input_gid = match nix::unistd::Group::from_name("input") {
        Ok(Some(g)) => g.gid,
        _ => return false,
    };
    match nix::unistd::getgroups() {
        Ok(groups) => groups.contains(&input_gid),
        Err(_) => false,
    }
}

/// Run all capability probes against `paths` and return the JSON diagnostic
/// string.  All four fields are always present.
pub fn run_check_json(paths: &CheckPaths) -> String {
    let uinput = uinput_ok(&paths.uinput);
    let evdev = evdev_ok(&paths.input_dir);
    let input_group = check_input_group();

    let config_ok = if paths.config.exists() {
        match std::fs::read_to_string(&paths.config) {
            Ok(toml_str) => conduit_core::config::compile(&toml_str).is_ok(),
            Err(_) => false,
        }
    } else {
        // Missing config is fine — the daemon creates a default on first run.
        true
    };

    format!(
        "{{\"uinput\":{},\"evdev\":{},\"input_group\":{},\"config_ok\":{}}}",
        uinput, evdev, input_group, config_ok
    )
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evdev_false_when_no_readable_event_nodes() {
        let t = std::env::temp_dir().join(format!("conduit-chk-{}", std::process::id()));
        std::fs::create_dir_all(&t).unwrap();
        let paths = CheckPaths {
            uinput: t.join("nonexistent-uinput"),
            input_dir: t.clone(), // empty dir: no event* nodes
            config: t.join("missing.toml"), // missing config is OK
        };
        let json = run_check_json(&paths);
        assert!(json.contains("\"evdev\":false"), "{json}");
        assert!(json.contains("\"uinput\":false"), "{json}");
        assert!(json.contains("\"config_ok\":true"), "{json}");
        std::fs::remove_dir_all(&t).ok();
    }

    #[test]
    fn evdev_true_when_a_readable_event_node_exists() {
        let t = std::env::temp_dir().join(format!("conduit-chk2-{}", std::process::id()));
        std::fs::create_dir_all(&t).unwrap();
        std::fs::write(t.join("event0"), b"").unwrap(); // plain readable file stands in
        let paths = CheckPaths {
            uinput: t.join("x"),
            input_dir: t.clone(),
            config: t.join("c.toml"),
        };
        let json = run_check_json(&paths);
        assert!(json.contains("\"evdev\":true"), "{json}");
        std::fs::remove_dir_all(&t).ok();
    }

    #[test]
    fn all_four_fields_present() {
        let t = std::env::temp_dir().join(format!("conduit-chk3-{}", std::process::id()));
        std::fs::create_dir_all(&t).unwrap();
        let paths = CheckPaths {
            uinput: t.join("u"),
            input_dir: t.clone(),
            config: t.join("c.toml"),
        };
        let json = run_check_json(&paths);
        assert!(json.contains("\"uinput\":"), "{json}");
        assert!(json.contains("\"evdev\":"), "{json}");
        assert!(json.contains("\"input_group\":"), "{json}");
        assert!(json.contains("\"config_ok\":"), "{json}");
        std::fs::remove_dir_all(&t).ok();
    }

    #[test]
    fn config_present_but_invalid_gives_config_ok_false() {
        let t = std::env::temp_dir().join(format!("conduit-chk4-{}", std::process::id()));
        std::fs::create_dir_all(&t).unwrap();
        let cfg = t.join("bad.toml");
        std::fs::write(&cfg, b"[[[invalid toml").unwrap();
        let paths = CheckPaths {
            uinput: t.join("u"),
            input_dir: t.clone(),
            config: cfg,
        };
        let json = run_check_json(&paths);
        assert!(json.contains("\"config_ok\":false"), "{json}");
        std::fs::remove_dir_all(&t).ok();
    }

    #[test]
    fn evdev_skips_non_event_files() {
        let t = std::env::temp_dir().join(format!("conduit-chk5-{}", std::process::id()));
        std::fs::create_dir_all(&t).unwrap();
        // Files that do NOT start with "event" should be skipped.
        std::fs::write(t.join("mouse0"), b"").unwrap();
        std::fs::write(t.join("js0"), b"").unwrap();
        let paths = CheckPaths {
            uinput: t.join("u"),
            input_dir: t.clone(),
            config: t.join("c.toml"),
        };
        let json = run_check_json(&paths);
        assert!(json.contains("\"evdev\":false"), "{json}");
        std::fs::remove_dir_all(&t).ok();
    }
}
