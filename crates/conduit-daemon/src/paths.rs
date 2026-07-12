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
        let tmp = std::env::temp_dir().join("conduit-test-config-home");
        // temp_env serializes all env-var mutations through an internal lock,
        // preventing races when tests run with --test-threads > 1.
        temp_env::with_var("XDG_CONFIG_HOME", Some(&tmp), || {
            let p = config_path();
            assert_eq!(p, tmp.join("conduit").join("conduit.toml"));
        });
    }

    #[test]
    fn config_path_falls_back_to_home_config() {
        let fake_home = std::env::temp_dir().join("conduit-test-home");
        // Remove XDG_CONFIG_HOME and override HOME simultaneously so neither
        // can bleed into another concurrently-running paths test.
        temp_env::with_vars(
            [
                ("XDG_CONFIG_HOME", None::<&std::ffi::OsStr>),
                ("HOME", Some(fake_home.as_os_str())),
            ],
            || {
                let p = config_path();
                assert_eq!(
                    p,
                    fake_home
                        .join(".config")
                        .join("conduit")
                        .join("conduit.toml")
                );
            },
        );
    }

    #[test]
    fn socket_path_honors_conduit_socket_override() {
        let override_path = "/tmp/my-conduit.sock";
        temp_env::with_var("CONDUIT_SOCKET", Some(override_path), || {
            let p = socket_path();
            assert_eq!(p, std::path::PathBuf::from(override_path));
        });
    }

    #[test]
    fn socket_path_uses_xdg_runtime_dir() {
        let runtime = std::env::temp_dir().join("conduit-test-runtime");
        temp_env::with_vars(
            [
                ("CONDUIT_SOCKET", None::<&std::ffi::OsStr>),
                ("XDG_RUNTIME_DIR", Some(runtime.as_os_str())),
            ],
            || {
                let p = socket_path();
                assert_eq!(p, runtime.join("conduit.sock"));
            },
        );
    }
}
