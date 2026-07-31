//! Peripheral battery readout via sysfs.
//!
//! The kernel exposes wireless-peripheral batteries under
//! `/sys/class/power_supply/` (`hidpp_battery_*` for Logitech HID++ devices,
//! `hid-*-battery` for Bluetooth HID). Peripheral batteries carry
//! `scope == Device`, which distinguishes them from the system battery
//! (`scope == System`), so no vendor-specific matching is needed.

use std::fs;
use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BatteryInfo {
    /// Human-readable device name (`model_name`, falling back to the sysfs
    /// node name).
    pub name: String,
    /// 0–100, absent when the kernel doesn't report `capacity`.
    pub percentage: Option<u8>,
    /// Normalized: `charging` | `discharging` | `full` | `not-charging` | `unknown`.
    pub status: String,
    pub charging: bool,
    pub serial: String,
}

/// Read one attribute file, trimming trailing whitespace. `None` when the
/// attribute is missing or unreadable.
fn read_attr(dir: &Path, attr: &str) -> Option<String> {
    let s = fs::read_to_string(dir.join(attr)).ok()?;
    let s = s.trim();
    if s.is_empty() { None } else { Some(s.to_string()) }
}

fn normalize_status(raw: &str) -> String {
    match raw.to_ascii_lowercase().as_str() {
        "charging" => "charging",
        "discharging" => "discharging",
        "full" => "full",
        "not charging" => "not-charging",
        _ => "unknown",
    }
    .to_string()
}

/// Build a `BatteryInfo` from raw attribute values. Returns `None` unless the
/// node is a peripheral battery (`type == Battery && scope == Device`).
fn battery_from_attrs(
    node_name: &str,
    supply_type: Option<&str>,
    scope: Option<&str>,
    model_name: Option<&str>,
    capacity: Option<&str>,
    status: Option<&str>,
    serial: Option<&str>,
) -> Option<BatteryInfo> {
    if !supply_type.is_some_and(|t| t.eq_ignore_ascii_case("battery")) {
        return None;
    }
    if !scope.is_some_and(|s| s.eq_ignore_ascii_case("device")) {
        return None;
    }
    let status = normalize_status(status.unwrap_or(""));
    Some(BatteryInfo {
        name: model_name.unwrap_or(node_name).to_string(),
        percentage: capacity.and_then(|c| c.parse::<u8>().ok()).map(|p| p.min(100)),
        charging: status == "charging",
        status,
        serial: serial.unwrap_or("").to_string(),
    })
}

/// Read a single power_supply sysfs node directory.
fn read_battery_dir(dir: &Path) -> Option<BatteryInfo> {
    let node_name = dir.file_name()?.to_string_lossy().into_owned();
    battery_from_attrs(
        &node_name,
        read_attr(dir, "type").as_deref(),
        read_attr(dir, "scope").as_deref(),
        read_attr(dir, "model_name").as_deref(),
        read_attr(dir, "capacity").as_deref(),
        read_attr(dir, "status").as_deref(),
        read_attr(dir, "serial_number").as_deref(),
    )
}

/// Enumerate all peripheral batteries, sorted by name for stable ordering.
pub fn read_batteries_from(root: &Path) -> Vec<BatteryInfo> {
    let mut out: Vec<BatteryInfo> = match fs::read_dir(root) {
        Ok(entries) => entries
            .flatten()
            .filter_map(|e| read_battery_dir(&e.path()))
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.serial.cmp(&b.serial)));
    out
}

pub fn read_batteries() -> Vec<BatteryInfo> {
    read_batteries_from(Path::new("/sys/class/power_supply"))
}

/// One tray-menu line per battery, e.g. `G502 X PLUS — 27% (charging)`.
pub fn menu_line(b: &BatteryInfo) -> String {
    let level = match (b.percentage, b.status.as_str()) {
        (_, "full") => "Full".to_string(),
        (Some(p), _) => format!("{p}%"),
        (None, _) => "?".to_string(),
    };
    match b.status.as_str() {
        "charging" => format!("{} — {} (charging)", b.name, level),
        _ => format!("{} — {}", b.name, level),
    }
}

#[tauri::command]
pub async fn list_batteries() -> Vec<BatteryInfo> {
    read_batteries()
}

// ---- Tests ----

#[cfg(test)]
mod tests {
    use super::*;

    fn hidpp(status: &str, capacity: Option<&str>) -> Option<BatteryInfo> {
        battery_from_attrs(
            "hidpp_battery_0",
            Some("Battery"),
            Some("Device"),
            Some("G502 X PLUS"),
            capacity,
            Some(status),
            Some("04-f9-ab-51"),
        )
    }

    #[test]
    fn peripheral_battery_parses() {
        let b = hidpp("Charging", Some("27")).unwrap();
        assert_eq!(b.name, "G502 X PLUS");
        assert_eq!(b.percentage, Some(27));
        assert_eq!(b.status, "charging");
        assert!(b.charging);
        assert_eq!(b.serial, "04-f9-ab-51");
    }

    #[test]
    fn system_battery_is_excluded() {
        let b = battery_from_attrs(
            "BAT0",
            Some("Battery"),
            Some("System"),
            None,
            Some("80"),
            Some("Discharging"),
            None,
        );
        assert!(b.is_none());
    }

    #[test]
    fn missing_scope_is_excluded() {
        // AC adapters and batteries without a scope attribute must not list.
        let b = battery_from_attrs("AC", Some("Mains"), None, None, None, None, None);
        assert!(b.is_none());
        let b = battery_from_attrs("BAT0", Some("Battery"), None, None, Some("80"), None, None);
        assert!(b.is_none());
    }

    #[test]
    fn missing_capacity_yields_none_percentage() {
        let b = hidpp("Discharging", None).unwrap();
        assert_eq!(b.percentage, None);
        assert!(!b.charging);
    }

    #[test]
    fn model_name_falls_back_to_node_name() {
        let b = battery_from_attrs(
            "hidpp_battery_3",
            Some("Battery"),
            Some("Device"),
            None,
            Some("50"),
            Some("Discharging"),
            None,
        )
        .unwrap();
        assert_eq!(b.name, "hidpp_battery_3");
    }

    #[test]
    fn status_normalization() {
        assert_eq!(hidpp("Full", Some("100")).unwrap().status, "full");
        assert_eq!(hidpp("Not charging", Some("90")).unwrap().status, "not-charging");
        assert_eq!(hidpp("Bogus", Some("10")).unwrap().status, "unknown");
    }

    #[test]
    fn menu_line_formats() {
        assert_eq!(
            menu_line(&hidpp("Charging", Some("27")).unwrap()),
            "G502 X PLUS — 27% (charging)"
        );
        assert_eq!(
            menu_line(&hidpp("Discharging", Some("64")).unwrap()),
            "G502 X PLUS — 64%"
        );
        assert_eq!(menu_line(&hidpp("Full", Some("100")).unwrap()), "G502 X PLUS — Full");
        assert_eq!(menu_line(&hidpp("Discharging", None).unwrap()), "G502 X PLUS — ?");
    }

    #[test]
    fn read_batteries_from_missing_dir_is_empty() {
        assert!(read_batteries_from(Path::new("/nonexistent-conduit-test")).is_empty());
    }
}
