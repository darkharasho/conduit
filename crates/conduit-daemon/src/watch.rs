//! Config file hot-reload watcher.
//!
//! Polls the config file's mtime every 500 ms. On change, reads and compiles
//! the new content. On success, sends `Msg::Reload` if the content differs from
//! the last content the watcher (or `set_config`) applied. On error, logs and
//! keeps the old config live.
//!
//! # Deduplication
//! `set_config` in `ipc.rs` writes a new config and immediately sends
//! `Msg::Reload`. Without coordination, the watcher would also detect the mtime
//! change and fire a redundant second reload. To prevent this, `ipc.rs` and
//! `watch::spawn` share an `Arc<Mutex<ReloadGate>>`. Whenever either side
//! applies new content, it records the content hash so the other can skip a
//! duplicate.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use crossbeam_channel::Sender;

use conduit_core::config;

use crate::runloop::Msg;

// ── ReloadGate ────────────────────────────────────────────────────────────────

/// Tracks the hash of the last config content that was successfully applied
/// (either by the watcher or by `set_config`). Used to skip redundant reloads.
///
/// This type is pure and has no I/O — all logic is unit-testable.
pub struct ReloadGate {
    last: Option<u64>,
}

impl ReloadGate {
    pub fn new() -> Self {
        Self { last: None }
    }

    /// Hash `content` with `DefaultHasher`.
    fn hash_content(content: &str) -> u64 {
        let mut h = DefaultHasher::new();
        content.hash(&mut h);
        h.finish()
    }

    /// Returns `true` if `content` is new (different from the last-seen hash)
    /// and records it as the new last-seen hash. Returns `false` for repeated
    /// content (skip the reload).
    pub fn should_reload(&mut self, content: &str) -> bool {
        let h = Self::hash_content(content);
        if self.last == Some(h) {
            return false;
        }
        self.last = Some(h);
        true
    }

    /// Record `content` as applied without triggering a reload. Call this from
    /// `set_config` after writing the file so the watcher skips the next mtime
    /// change that results from the write.
    pub fn record(&mut self, content: &str) {
        let h = Self::hash_content(content);
        self.last = Some(h);
    }
}

// ── Watcher thread ────────────────────────────────────────────────────────────

/// Spawn a background thread that polls `config_path` every 500 ms.
///
/// On mtime change: read the file, compile it. On success: call
/// `gate.should_reload()`; if true send `Msg::Reload`. On compile error: log
/// and keep the old config live.
///
/// The `gate` must be the same `Arc<Mutex<ReloadGate>>` passed to the IPC
/// server so that `set_config` writes are deduplicated.
pub fn spawn(
    config_path: PathBuf,
    tx: Sender<Msg>,
    gate: Arc<Mutex<ReloadGate>>,
) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("conduit-watch".into())
        .spawn(move || poll_loop(config_path, tx, gate))
        .expect("spawning watch thread")
}

fn poll_loop(config_path: PathBuf, tx: Sender<Msg>, gate: Arc<Mutex<ReloadGate>>) {
    let mut last_mtime: Option<SystemTime> = None;

    loop {
        std::thread::sleep(Duration::from_millis(500));

        // Read current mtime; if the file disappeared, just continue.
        let mtime = match std::fs::metadata(&config_path)
            .and_then(|m| m.modified())
        {
            Ok(t) => t,
            Err(_) => continue,
        };

        // Skip if mtime unchanged.
        if last_mtime == Some(mtime) {
            continue;
        }
        last_mtime = Some(mtime);

        // mtime changed — read and compile.
        let content = match std::fs::read_to_string(&config_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!(
                    "conduit/watch: could not read {}: {e}",
                    config_path.display()
                );
                continue;
            }
        };

        let compiled = match config::compile(&content) {
            Ok(c) => c,
            Err(e) => {
                eprintln!(
                    "conduit/watch: config error in {}: {e}",
                    config_path.display()
                );
                // last_mtime already updated above; next poll with same mtime skips (avoids retry spam).
                continue;
            }
        };

        // Check whether this content is genuinely new.
        let reload = {
            let mut g = gate.lock().unwrap();
            g.should_reload(&content)
        };

        if reload {
            eprintln!("conduit/watch: reloading config from {}", config_path.display());
            if tx.send(Msg::Reload(compiled)).is_err() {
                // Run loop has shut down; exit the watcher.
                break;
            }
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_new_content_triggers_reload() {
        let mut gate = ReloadGate::new();
        assert!(gate.should_reload("content_a"), "first content should trigger reload");
    }

    #[test]
    fn gate_same_content_skips_reload() {
        let mut gate = ReloadGate::new();
        gate.should_reload("content_a");
        assert!(!gate.should_reload("content_a"), "identical content should skip reload");
    }

    #[test]
    fn gate_changed_content_triggers_reload_again() {
        let mut gate = ReloadGate::new();
        gate.should_reload("content_a");
        assert!(gate.should_reload("content_b"), "changed content should trigger reload");
    }

    #[test]
    fn gate_record_prevents_subsequent_same_reload() {
        let mut gate = ReloadGate::new();
        // Simulate set_config recording the content it wrote.
        gate.record("content_from_set_config");
        // Watcher reads the same content from disk — should skip.
        assert!(
            !gate.should_reload("content_from_set_config"),
            "watcher should skip content already recorded by set_config"
        );
    }

    #[test]
    fn gate_record_does_not_suppress_different_content() {
        let mut gate = ReloadGate::new();
        gate.record("content_a");
        // A genuinely different hand-edit should still trigger a reload.
        assert!(
            gate.should_reload("content_b"),
            "different content after record should still trigger reload"
        );
    }

    #[test]
    fn gate_alternating_content_triggers_each_time() {
        let mut gate = ReloadGate::new();
        assert!(gate.should_reload("a"));
        assert!(gate.should_reload("b"));
        assert!(gate.should_reload("a")); // back to "a" is new again
    }

    #[test]
    fn gate_empty_string_is_valid_content() {
        let mut gate = ReloadGate::new();
        assert!(gate.should_reload(""));
        assert!(!gate.should_reload(""));
    }
}
