//! Opt-in event trace for diagnosing lost input events.
//!
//! Written for the intermittent PTT/F18 investigation
//! (`docs/ptt-f18-inconsistent-investigation.md`): the trace shows, per
//! grabbed device, whether a key event was read from the kernel, sent to the
//! engine, and emitted on the virtual output — and timestamps every hotplug
//! add/remove so wireless disconnect blips can be correlated with lost or
//! synthesized key events.
//!
//! Enabled by setting `CONDUIT_TRACE` to any value other than empty or `"0"`
//! in the daemon's environment (e.g. `Environment=CONDUIT_TRACE=1` in a
//! systemd drop-in). Disabled, the only cost at call sites is a branch on a
//! cached bool.

use std::sync::OnceLock;

/// Pure decision: is the trace enabled for this env-var value?
/// `None` (unset), `""` and `"0"` mean disabled; anything else enables.
pub fn parse_enabled(val: Option<&str>) -> bool {
    matches!(val, Some(v) if !v.is_empty() && v != "0")
}

/// Whether `CONDUIT_TRACE` enables the trace. Reads the environment once.
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| parse_enabled(std::env::var("CONDUIT_TRACE").ok().as_deref()))
}

/// Emit one trace line to stderr, stamped with the monotonic `now_us()` time
/// base shared with event timestamps.
pub fn log(args: std::fmt::Arguments) {
    eprintln!("conduit[trace] t={}us {}", crate::runloop::now_us(), args);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_enabled_off_when_unset_empty_or_zero() {
        assert!(!parse_enabled(None));
        assert!(!parse_enabled(Some("")));
        assert!(!parse_enabled(Some("0")));
    }

    #[test]
    fn parse_enabled_on_for_any_other_value() {
        assert!(parse_enabled(Some("1")));
        assert!(parse_enabled(Some("true")));
        assert!(parse_enabled(Some("yes")));
    }
}
