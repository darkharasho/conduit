use std::path::PathBuf;

/// Returns the path to the conduit configuration file.
/// Honors `$XDG_CONFIG_HOME`; falls back to `~/.config`.
pub fn config_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs_base().join(".config")
        });
    base.join("conduit").join("conduit.toml")
}

/// Returns the path to the conduit Unix domain socket.
/// Honors `$CONDUIT_SOCKET` override first (needed by Task 14 tests),
/// otherwise uses `$XDG_RUNTIME_DIR/conduit.sock`.
pub fn socket_path() -> PathBuf {
    if let Some(val) = std::env::var_os("CONDUIT_SOCKET") {
        return PathBuf::from(val);
    }
    let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/run/user/1000"));
    runtime_dir.join("conduit.sock")
}

fn dirs_base() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/root"))
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_path_uses_xdg_config_home() {
        // Safety: single-threaded test context; env manipulation is local to this block.
        // We use a temp dir to avoid side effects.
        let tmp = std::env::temp_dir().join("conduit-test-config-home");
        std::env::set_var("XDG_CONFIG_HOME", &tmp);
        let p = config_path();
        std::env::remove_var("XDG_CONFIG_HOME");
        assert_eq!(p, tmp.join("conduit").join("conduit.toml"));
    }

    #[test]
    fn config_path_falls_back_to_home_config() {
        std::env::remove_var("XDG_CONFIG_HOME");
        // Set HOME to a known value
        let fake_home = std::env::temp_dir().join("conduit-test-home");
        let orig_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &fake_home);
        let p = config_path();
        // Restore
        if let Some(h) = orig_home {
            std::env::set_var("HOME", h);
        } else {
            std::env::remove_var("HOME");
        }
        assert_eq!(p, fake_home.join(".config").join("conduit").join("conduit.toml"));
    }

    #[test]
    fn socket_path_honors_conduit_socket_override() {
        let override_path = "/tmp/my-conduit.sock";
        std::env::set_var("CONDUIT_SOCKET", override_path);
        let p = socket_path();
        std::env::remove_var("CONDUIT_SOCKET");
        assert_eq!(p, std::path::PathBuf::from(override_path));
    }

    #[test]
    fn socket_path_uses_xdg_runtime_dir() {
        std::env::remove_var("CONDUIT_SOCKET");
        let runtime = std::env::temp_dir().join("conduit-test-runtime");
        std::env::set_var("XDG_RUNTIME_DIR", &runtime);
        let p = socket_path();
        std::env::remove_var("XDG_RUNTIME_DIR");
        assert_eq!(p, runtime.join("conduit.sock"));
    }
}
