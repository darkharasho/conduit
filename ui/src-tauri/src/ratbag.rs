use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::ErrorPayload;

// ---- Constants ----

/// Directory for custom libratbag device data files.
pub const DATA_DIR: &str = "/etc/libratbag-custom";

/// Embedded stock content for the G502 X device file, used as a fallback when
/// /usr/share/libratbag/logitech-g502-x.device is unreadable at runtime.
const G502X_STOCK: &str = "\
[Device]\n\
Name=Logitech G502 X\n\
DeviceMatch=usb:046d:c099\n\
DeviceType=mouse\n\
Driver=hidpp20\n";

// ---- Pure functions ----

/// Parses the INI-ish `stock` .device file content and extends the `DeviceMatch=`
/// line with the extra match IDs in `extra_matches` (semicolon-separated, deduplicated).
/// Everything else is preserved byte-identical.
/// If the `DeviceMatch=` line is absent, appends one.
/// Never panics; malformed input is returned unchanged with the match line appended.
pub fn patched_device_file(stock: &str, extra_matches: &[&str]) -> String {
    let mut found = false;
    let mut lines: Vec<String> = stock
        .lines()
        .map(|line| {
            if line.starts_with("DeviceMatch=") {
                found = true;
                let existing: &str = line.strip_prefix("DeviceMatch=").unwrap_or("");
                // Collect all current IDs
                let mut ids: Vec<&str> = existing.split(';').filter(|s| !s.is_empty()).collect();
                // Append extras, deduping
                let mut seen: HashSet<&str> = ids.iter().copied().collect();
                for extra in extra_matches {
                    if seen.insert(extra) {
                        ids.push(extra);
                    }
                }
                format!("DeviceMatch={}", ids.join(";"))
            } else {
                line.to_string()
            }
        })
        .collect();

    if !found {
        // Append a DeviceMatch= line
        let ids: Vec<&str> = extra_matches.to_vec();
        lines.push(format!("DeviceMatch={}", ids.join(";")));
    }

    // Reconstruct: preserve trailing newline if original had one
    let mut result = lines.join("\n");
    if stock.ends_with('\n') {
        result.push('\n');
    }
    result
}

/// Returns the systemd drop-in content that sets `LIBRATBAG_DATA_DIR`.
pub fn ratbagd_dropin() -> &'static str {
    "[Service]\nEnvironment=LIBRATBAG_DATA_DIR=/etc/libratbag-custom\n"
}

/// Validates a temp path against the pattern `^/tmp/conduit-ratbag-[A-Za-z0-9]+/[a-z0-9.-]+$`.
fn validate_temp_path(path: &str) -> Result<(), String> {
    // Manual regex to avoid pulling in the regex crate
    let rest = path
        .strip_prefix("/tmp/conduit-ratbag-")
        .ok_or_else(|| format!("invalid temp path: {:?}", path))?;

    // Split on the first '/' — rest = "<rand>/<filename>"
    let slash = rest
        .find('/')
        .ok_or_else(|| format!("invalid temp path: {:?}", path))?;
    let rand_part = &rest[..slash];
    let file_part = &rest[slash + 1..];

    // rand_part: [A-Za-z0-9]+
    if rand_part.is_empty()
        || !rand_part
            .chars()
            .all(|c| c.is_ascii_alphanumeric())
    {
        return Err(format!("invalid temp path: {:?}", path));
    }

    // file_part: [a-z0-9.-]+ (no path separators, no empty)
    if file_part.is_empty()
        || file_part.contains('/')
        || !file_part
            .chars()
            .all(|c| matches!(c, 'a'..='z' | '0'..='9' | '.' | '-'))
    {
        return Err(format!("invalid temp path: {:?}", path));
    }

    Ok(())
}

/// Generates the shell script that runs under a single `pkexec` prompt to:
/// - Copy stock libratbag data to `/etc/libratbag-custom`
/// - Copy the pre-written patched device file from `temp_path`
/// - Install the systemd drop-in for ratbagd
/// - Reload and restart ratbagd
///
/// `temp_path` must match `^/tmp/conduit-ratbag-[A-Za-z0-9]+/[a-z0-9.-]+$`.
/// Returns `Err` if the path fails validation.
pub fn fix_setup_script(temp_path: &str) -> Result<String, String> {
    validate_temp_path(temp_path)?;

    // Extract just the filename for the destination copy
    let file_name = temp_path.rsplit('/').next().unwrap_or("device");

    let dropin = ratbagd_dropin();

    let script = format!(
        "set -e\n\
mkdir -p {data_dir}\n\
cp -r /usr/share/libratbag/. {data_dir}/\n\
cp {temp_path} {data_dir}/{file_name}\n\
mkdir -p /etc/systemd/system/ratbagd.service.d\n\
printf '%s' '{dropin_escaped}' > /etc/systemd/system/ratbagd.service.d/conduit-data-dir.conf\n\
systemctl daemon-reload\n\
systemctl enable --now ratbagd\n\
systemctl restart ratbagd\n",
        data_dir = DATA_DIR,
        temp_path = temp_path,
        file_name = file_name,
        dropin_escaped = dropin.replace('\'', "'\\''"),
    );
    Ok(script)
}

// ---- Button map types ----

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OnboardButton {
    pub index: u8,
    pub action: String,
}

/// DTO returned to the frontend — adds a human-readable label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnboardButtonDto {
    pub index: u8,
    pub action: String,
    pub human: String,
}

// ---- Pure parsers ----

/// Parses `ratbagctl <dev> info` output lines of the form:
///   `  Button: 6 is mapped to 'button 1'`
///   `  Button: 7 is mapped to macro '↕KEY_F18'`
///   `  Button: 8 is mapped to 'none'`
pub fn parse_button_map(info_output: &str) -> Vec<OnboardButton> {
    let mut buttons = Vec::new();
    for line in info_output.lines() {
        let line = line.trim();
        // Pattern: "Button: <N> is mapped to '<action>'"
        let Some(rest) = line.strip_prefix("Button: ") else {
            continue;
        };
        let Some((index_str, rest)) = rest.split_once(" is mapped to '") else {
            continue;
        };
        let Ok(index) = index_str.trim().parse::<u8>() else {
            continue;
        };
        // Strip exactly ONE trailing quote (the outer wrapper); inner quotes are preserved
        let action = rest.strip_suffix('\'').unwrap_or(rest);
        buttons.push(OnboardButton {
            index,
            action: action.to_string(),
        });
    }
    // Sort by index for determinism
    buttons.sort_by_key(|b| b.index);
    buttons
}

/// Returns a human-readable label for a ratbagctl action string.
///
/// Examples:
/// - `"button 1"` → `"Left click"`
/// - `"button 2"` → `"Right click"`
/// - `"button 3"` → `"Middle click"`
/// - `"button 4"` → `"Back"`
/// - `"button 5"` → `"Forward"`
/// - `"button N"` → `"Button N"`
/// - `"macro '↕KEY_F18'"` → `"Types F18"`
/// - `"key KEY_ESC"` → `"Esc"`
/// - `"none"` → `"Nothing"`
pub fn humanize_action(action: &str) -> String {
    if action == "none" {
        return "Nothing".to_string();
    }
    // "button N"
    if let Some(rest) = action.strip_prefix("button ") {
        return match rest.trim() {
            "1" => "Left click".to_string(),
            "2" => "Right click".to_string(),
            "3" => "Middle click".to_string(),
            "4" => "Back".to_string(),
            "5" => "Forward".to_string(),
            n => format!("Button {}", n),
        };
    }
    // "macro '↕KEY_F18'" or "macro '↕KEY_X'"
    if let Some(rest) = action.strip_prefix("macro '") {
        let rest = rest.trim_end_matches('\'');
        // Strip direction prefix chars (↕ ↓ ↑)
        let key_name = rest.trim_start_matches(|c: char| !c.is_ascii_uppercase() && c != 'K');
        if let Some(key) = key_name.strip_prefix("KEY_") {
            return format!("Types {}", key);
        }
        return format!("Types {}", key_name);
    }
    // "key KEY_ESC" etc.
    if let Some(rest) = action.strip_prefix("key ") {
        let key = rest.strip_prefix("KEY_").unwrap_or(rest);
        return key.to_string();
    }
    // "special <name>"
    if let Some(rest) = action.strip_prefix("special ") {
        return rest.to_string();
    }
    // fallback
    action.to_string()
}

/// Applies the collision-fix policy to a button map and returns the rewrite targets.
///
/// Policy:
/// - Skip indices 0, 1, 2 (never retargeted)
/// - Skip buttons mapped to `button 4` or `button 5` (Back/Forward)
/// - Identify duplicates of `button 1`, `button 2`, `button 3`
/// - Identify buttons mapped to keys/macros that collide with Esc or duplicate each other
/// - Assign `KEY_F13`, `KEY_F14`, … in index order
pub fn rewrite_targets(buttons: &[OnboardButton]) -> Vec<(u8, String)> {
    // Collect actions seen so far (for collision detection)
    let mut seen_actions: HashSet<String> = HashSet::new();
    // Collect button actions used at index <= 2
    let protected: HashSet<String> = buttons
        .iter()
        .filter(|b| b.index <= 2)
        .map(|b| b.action.clone())
        .collect();

    // Actions we never want to produce as duplicates from higher indices
    // (button 1/2/3 are typical L/R/M clicks)
    let collision_anchors: HashSet<&str> = ["button 1", "button 2", "button 3"].iter().copied().collect();

    // The "Esc" key action variants
    let esc_actions: HashSet<&str> = [
        "key KEY_ESC",
        "key Esc",
        "macro '↕KEY_ESC'",
        "macro '↑KEY_ESC'",
        "macro '↓KEY_ESC'",
    ]
    .iter()
    .copied()
    .collect();

    let mut targets: Vec<u8> = Vec::new();

    // Sort by index (should already be sorted from parse_button_map)
    let mut sorted: Vec<&OnboardButton> = buttons.iter().collect();
    sorted.sort_by_key(|b| b.index);

    // First pass: record actions for indices 0..=2
    for b in sorted.iter().filter(|b| b.index <= 2) {
        seen_actions.insert(b.action.clone());
    }

    // Second pass: identify targets among index > 2
    for b in sorted.iter().filter(|b| b.index > 2) {
        let action = &b.action;

        // Skip Back/Forward
        if action == "button 4" || action == "button 5" {
            continue;
        }

        // Is it a collision?
        let is_collision = collision_anchors.contains(action.as_str())
            || esc_actions.contains(action.as_str())
            || protected.contains(action.as_str())
            || seen_actions.contains(action.as_str());

        if is_collision {
            targets.push(b.index);
        } else {
            // Record it so later duplicates of this action are also caught
            seen_actions.insert(action.clone());
        }
    }

    // Assign KEY_F13..KEY_F24 in order
    targets.sort();
    targets
        .into_iter()
        .enumerate()
        .map(|(i, idx)| {
            let fkey = format!("KEY_F{}", 13 + i as u32);
            (idx, fkey)
        })
        .collect()
}

// ---- Response types ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RatbagStatus {
    pub daemon_running: bool,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
}

// ---- Tauri commands ----

/// Stage the patched G502 X device file to a fresh temp directory.
/// Returns the temp path (validated).
#[tauri::command]
pub async fn ratbag_stage_device_file() -> Result<String, ErrorPayload> {
    // Try to read the stock file; fall back to embedded copy
    let stock = std::fs::read_to_string("/usr/share/libratbag/logitech-g502-x.device")
        .unwrap_or_else(|_| G502X_STOCK.to_string());

    // G502 X family USB IDs: wired c099 (stock), LIGHTSPEED receiver c547, wired X PLUS c095
    let extra = &["usb:046d:c099", "usb:046d:c095", "usb:046d:c547"];
    let patched = patched_device_file(&stock, extra);

    // Create a fresh temp dir: /tmp/conduit-ratbag-<rand>/
    let rand_suffix = generate_random_suffix(8);
    let dir = format!("/tmp/conduit-ratbag-{}", rand_suffix);
    std::fs::create_dir_all(&dir).map_err(|e| {
        ErrorPayload::new("internal", "failed to create temp directory", e.to_string())
    })?;

    let dest_path = format!("{}/logitech-g502-x.device", dir);
    std::fs::write(&dest_path, &patched).map_err(|e| {
        ErrorPayload::new("internal", "failed to write patched device file", e.to_string())
    })?;

    Ok(dest_path)
}

/// Query ratbagd status and G502 X presence via `ratbagctl list`.
#[tauri::command]
pub async fn ratbag_status() -> Result<RatbagStatus, ErrorPayload> {
    let out = std::process::Command::new("ratbagctl")
        .arg("list")
        .output()
        .map_err(|e| ErrorPayload::new("internal", "failed to run ratbagctl", e.to_string()))?;

    let daemon_running = out.status.success();
    let stdout = String::from_utf8_lossy(&out.stdout);

    let (device_id, device_name) = parse_ratbagctl_list(&stdout);

    Ok(RatbagStatus {
        daemon_running,
        device_id,
        device_name,
    })
}

/// Read button map for a device via `ratbagctl <id> info`.
#[tauri::command]
pub async fn ratbag_read_buttons(device_id: String) -> Result<Vec<OnboardButtonDto>, ErrorPayload> {
    let out = std::process::Command::new("ratbagctl")
        .arg(&device_id)
        .arg("info")
        .output()
        .map_err(|e| ErrorPayload::new("internal", "failed to run ratbagctl", e.to_string()))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(ErrorPayload::new("internal", "ratbagctl info failed", stderr));
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let buttons = parse_button_map(&stdout);
    let dtos = buttons
        .into_iter()
        .map(|b| {
            let human = humanize_action(&b.action);
            OnboardButtonDto {
                index: b.index,
                action: b.action,
                human,
            }
        })
        .collect();

    Ok(dtos)
}

/// Run the one-prompt setup script under pkexec.
#[tauri::command]
pub async fn ratbag_fix_setup(patched_device_temp_path: String) -> Result<(), ErrorPayload> {
    let script = fix_setup_script(&patched_device_temp_path).map_err(|e| {
        ErrorPayload::new("internal", "invalid temp path", e)
    })?;

    let out = std::process::Command::new("pkexec")
        .args(["sh", "-c", &script])
        .output()
        .map_err(|e| ErrorPayload::new("internal", "failed to run pkexec", e.to_string()))?;

    let exit_code = out.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

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
            "ratbag setup script failed",
            stderr,
        ));
    }

    Ok(())
}

/// Compute the collision-fix rewrite targets from a button map (pure, no I/O).
/// Returns the list of `(button_index, key_name)` pairs the wizard should propose.
#[tauri::command]
pub async fn ratbag_suggest_rewrites(
    buttons: Vec<OnboardButton>,
) -> Result<Vec<(u8, String)>, ErrorPayload> {
    Ok(rewrite_targets(&buttons))
}

/// Rewrite button mappings via sequential ratbagctl calls.
/// `targets` is a list of (button_index, key_name) pairs.
#[tauri::command]
pub async fn ratbag_rewrite(
    device_id: String,
    targets: Vec<(u8, String)>,
) -> Result<(), ErrorPayload> {
    for (index, key_name) in &targets {
        let macro_down = format!("+{}", key_name);
        let macro_up = format!("-{}", key_name);
        let out = std::process::Command::new("ratbagctl")
            .arg(&device_id)
            .arg("profile")
            .arg("0")
            .arg("button")
            .arg(index.to_string())
            .arg("action")
            .arg("set")
            .arg("macro")
            .arg(&macro_down)
            .arg(&macro_up)
            .output()
            .map_err(|e| {
                ErrorPayload::new("internal", "failed to run ratbagctl", e.to_string())
            })?;

        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            return Err(ErrorPayload::new(
                "internal",
                format!("ratbagctl rewrite failed for button {}", index),
                stderr,
            ));
        }
    }
    Ok(())
}

// ---- Private helpers ----

/// Parse `ratbagctl list` output for a G502 X family device.
/// Returns `(device_id, device_name)` if found.
fn parse_ratbagctl_list(output: &str) -> (Option<String>, Option<String>) {
    // Example line: "logitech-g502-x-plus:usb:046d:c547:1  Logitech G502 X PLUS"
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // Split on first whitespace — id is the token before, name is the rest
        let (id, name) = if let Some(pos) = line.find(|c: char| c.is_whitespace()) {
            (line[..pos].trim(), line[pos..].trim())
        } else {
            (line, "")
        };
        // Check if name or id looks like a G502 X
        if name.contains("G502") || id.contains("g502") {
            return (
                Some(id.to_string()),
                if name.is_empty() { None } else { Some(name.to_string()) },
            );
        }
    }
    (None, None)
}

/// Generate a simple alphanumeric random suffix using /dev/urandom.
fn generate_random_suffix(len: usize) -> String {
    const CHARSET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut buf = vec![0u8; len];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut buf);
    }
    buf.iter()
        .map(|&b| CHARSET[(b as usize) % CHARSET.len()] as char)
        .collect()
}

// ---- Tests ----

#[cfg(test)]
mod tests {
    use super::*;

    // Stock content mirroring /usr/share/libratbag/logitech-g502-x.device
    const STOCK: &str = "\
[Device]\n\
Name=Logitech G502 X\n\
DeviceMatch=usb:046d:c099\n\
DeviceType=mouse\n\
Driver=hidpp20\n";

    // ---- patched_device_file ----

    #[test]
    fn patched_device_file_extends_match_line() {
        let result = patched_device_file(
            STOCK,
            &["usb:046d:c099", "usb:046d:c095", "usb:046d:c547"],
        );
        // DeviceMatch line should have all three IDs
        assert!(
            result.contains("DeviceMatch=usb:046d:c099;usb:046d:c095;usb:046d:c547"),
            "got: {:?}",
            result
        );
    }

    #[test]
    fn patched_device_file_deduplicates() {
        // If the stock already has c099, passing it again should not produce a duplicate
        let result = patched_device_file(
            STOCK,
            &["usb:046d:c099", "usb:046d:c099", "usb:046d:c095"],
        );
        let match_line = result
            .lines()
            .find(|l| l.starts_with("DeviceMatch="))
            .unwrap();
        let ids: Vec<&str> = match_line
            .strip_prefix("DeviceMatch=")
            .unwrap()
            .split(';')
            .collect();
        assert_eq!(
            ids.iter().filter(|&&id| id == "usb:046d:c099").count(),
            1,
            "c099 should appear exactly once"
        );
    }

    #[test]
    fn patched_device_file_preserves_other_lines_byte_identical() {
        let result = patched_device_file(STOCK, &["usb:046d:c095"]);
        assert!(result.contains("[Device]\n"), "section header preserved");
        assert!(
            result.contains("Name=Logitech G502 X\n"),
            "Name line preserved"
        );
        assert!(
            result.contains("DeviceType=mouse\n"),
            "DeviceType line preserved"
        );
        assert!(
            result.contains("Driver=hidpp20\n"),
            "Driver line preserved"
        );
    }

    #[test]
    fn patched_device_file_preserves_trailing_newline() {
        assert!(patched_device_file(STOCK, &[]).ends_with('\n'));
        let no_newline = "DeviceMatch=usb:046d:c099";
        assert!(!patched_device_file(no_newline, &["usb:046d:c095"]).ends_with('\n'));
    }

    #[test]
    fn patched_device_file_appends_match_line_if_absent() {
        let stock = "[Device]\nName=X\nDeviceType=mouse\n";
        let result = patched_device_file(stock, &["usb:046d:c095"]);
        assert!(result.contains("DeviceMatch=usb:046d:c095"));
    }

    // ---- ratbagd_dropin ----

    #[test]
    fn ratbagd_dropin_content() {
        let d = ratbagd_dropin();
        assert_eq!(
            d,
            "[Service]\nEnvironment=LIBRATBAG_DATA_DIR=/etc/libratbag-custom\n"
        );
    }

    // ---- fix_setup_script ----

    #[test]
    fn fix_setup_script_is_single_prompt_batch() {
        let path = "/tmp/conduit-ratbag-Abc123/logitech-g502-x.device";
        let s = fix_setup_script(path).unwrap();

        assert!(s.starts_with("set -e\n"), "must start with set -e");
        assert!(!s.contains("pkexec"), "script runs UNDER pkexec, never invokes it");
        assert!(
            s.contains("cp -r /usr/share/libratbag/. /etc/libratbag-custom/"),
            "must copy stock libratbag data"
        );
        assert!(
            s.contains(&format!("cp {} /etc/libratbag-custom/logitech-g502-x.device", path)),
            "must copy patched file"
        );
        assert!(
            s.contains("mkdir -p /etc/systemd/system/ratbagd.service.d"),
            "must create drop-in dir"
        );
        assert!(
            s.contains("LIBRATBAG_DATA_DIR=/etc/libratbag-custom"),
            "must write drop-in with data dir"
        );
        assert!(s.contains("systemctl daemon-reload"), "must reload");
        assert!(s.contains("systemctl enable --now ratbagd"), "must enable ratbagd");
        assert!(s.contains("systemctl restart ratbagd"), "must restart ratbagd");
    }

    #[test]
    fn fix_setup_script_rejects_hostile_path() {
        assert!(fix_setup_script("/etc/passwd").is_err());
        assert!(fix_setup_script("/tmp/conduit-ratbag-abc/../../etc/passwd").is_err());
        assert!(fix_setup_script("/tmp/conduit-ratbag-abc/UPPER.device").is_err()); // uppercase in filename
        assert!(fix_setup_script("/tmp/conduit-ratbag-!/logitech.device").is_err()); // invalid rand part
        assert!(fix_setup_script("/tmp/conduit-ratbag-abc/lo gitech.device").is_err()); // space
    }

    #[test]
    fn fix_setup_script_accepts_valid_path() {
        assert!(fix_setup_script("/tmp/conduit-ratbag-Abc123XZ/logitech-g502-x.device").is_ok());
        assert!(fix_setup_script("/tmp/conduit-ratbag-ABCDEFGH/device.file").is_ok());
        assert!(fix_setup_script("/tmp/conduit-ratbag-0123456789/foo.device").is_ok());
    }

    // ---- parse_button_map ----

    const SAMPLE_INFO: &str = "
  Button: 0 is mapped to 'button 1'
  Button: 1 is mapped to 'button 2'
  Button: 2 is mapped to 'button 3'
  Button: 3 is mapped to 'button 4'
  Button: 4 is mapped to 'button 5'
  Button: 5 is mapped to 'button 1'
  Button: 6 is mapped to 'button 1'
  Button: 7 is mapped to 'key KEY_ESC'
  Button: 8 is mapped to 'none'
  Button: 9 is mapped to 'macro '↕KEY_F18''
";

    #[test]
    fn parse_button_map_parses_standard_lines() {
        let buttons = parse_button_map(SAMPLE_INFO);
        assert!(!buttons.is_empty());

        let b0 = buttons.iter().find(|b| b.index == 0).unwrap();
        assert_eq!(b0.action, "button 1");

        let b6 = buttons.iter().find(|b| b.index == 6).unwrap();
        assert_eq!(b6.action, "button 1");

        let b8 = buttons.iter().find(|b| b.index == 8).unwrap();
        assert_eq!(b8.action, "none");

        let b9 = buttons.iter().find(|b| b.index == 9).unwrap();
        assert_eq!(b9.action, "macro '↕KEY_F18'");
    }

    #[test]
    fn parse_button_map_parses_macro_and_key_actions() {
        let input = "  Button: 6 is mapped to 'macro '↕KEY_F18''
  Button: 7 is mapped to 'key KEY_ESC'
  Button: 8 is mapped to 'none'";
        let buttons = parse_button_map(input);

        assert_eq!(
            buttons.iter().find(|b| b.index == 6).map(|b| b.action.as_str()),
            Some("macro '↕KEY_F18'")
        );
        assert_eq!(
            buttons.iter().find(|b| b.index == 7).map(|b| b.action.as_str()),
            Some("key KEY_ESC")
        );
        assert_eq!(
            buttons.iter().find(|b| b.index == 8).map(|b| b.action.as_str()),
            Some("none")
        );
    }

    // ---- humanize_action ----

    #[test]
    fn humanize_action_standard_buttons() {
        assert_eq!(humanize_action("button 1"), "Left click");
        assert_eq!(humanize_action("button 2"), "Right click");
        assert_eq!(humanize_action("button 3"), "Middle click");
        assert_eq!(humanize_action("button 4"), "Back");
        assert_eq!(humanize_action("button 5"), "Forward");
        assert_eq!(humanize_action("button 6"), "Button 6");
    }

    #[test]
    fn humanize_action_macro() {
        assert_eq!(humanize_action("macro '↕KEY_F18'"), "Types F18");
        assert_eq!(humanize_action("macro '↕KEY_F13'"), "Types F13");
    }

    #[test]
    fn humanize_action_none() {
        assert_eq!(humanize_action("none"), "Nothing");
    }

    #[test]
    fn humanize_action_key() {
        // "key KEY_ESC" → "ESC" (strips KEY_ prefix)
        let result = humanize_action("key KEY_ESC");
        assert!(!result.is_empty());
        // Should not contain "KEY_" in the output
        assert!(!result.contains("KEY_"), "got: {:?}", result);
    }

    // ---- rewrite_targets ----

    fn sample_g502x_buttons() -> Vec<OnboardButton> {
        vec![
            OnboardButton { index: 0, action: "button 1".to_string() },
            OnboardButton { index: 1, action: "button 2".to_string() },
            OnboardButton { index: 2, action: "button 3".to_string() },
            OnboardButton { index: 3, action: "button 4".to_string() },
            OnboardButton { index: 4, action: "button 5".to_string() },
            OnboardButton { index: 5, action: "button 1".to_string() }, // duplicate
            OnboardButton { index: 6, action: "button 1".to_string() }, // duplicate
            OnboardButton { index: 7, action: "key KEY_ESC".to_string() }, // Esc collision
        ]
    }

    #[test]
    fn rewrite_targets_identifies_duplicates_and_esc() {
        let buttons = sample_g502x_buttons();
        let targets = rewrite_targets(&buttons);

        // Indices 5, 6 duplicate button 1; index 7 is Esc
        let indices: Vec<u8> = targets.iter().map(|(i, _)| *i).collect();
        assert!(indices.contains(&5), "index 5 should be a target: {:?}", indices);
        assert!(indices.contains(&6), "index 6 should be a target: {:?}", indices);
        assert!(indices.contains(&7), "index 7 (Esc) should be a target: {:?}", indices);
    }

    #[test]
    fn rewrite_targets_leaves_back_forward_untouched() {
        let buttons = sample_g502x_buttons();
        let targets = rewrite_targets(&buttons);
        let indices: Vec<u8> = targets.iter().map(|(i, _)| *i).collect();
        // button 4 = Back (index 3), button 5 = Forward (index 4) — should not be in targets
        assert!(!indices.contains(&3), "Back should not be targeted");
        assert!(!indices.contains(&4), "Forward should not be targeted");
    }

    #[test]
    fn rewrite_targets_never_targets_indices_0_1_2() {
        let buttons = sample_g502x_buttons();
        let targets = rewrite_targets(&buttons);
        let indices: Vec<u8> = targets.iter().map(|(i, _)| *i).collect();
        assert!(!indices.contains(&0));
        assert!(!indices.contains(&1));
        assert!(!indices.contains(&2));
    }

    #[test]
    fn rewrite_targets_assigns_fkeys_in_index_order() {
        let buttons = sample_g502x_buttons();
        let targets = rewrite_targets(&buttons);

        // Should be sorted by index
        let indices: Vec<u8> = targets.iter().map(|(i, _)| *i).collect();
        let mut sorted = indices.clone();
        sorted.sort();
        assert_eq!(indices, sorted, "targets must be in index order");

        // F-keys assigned starting at F13
        for (i, (_, key)) in targets.iter().enumerate() {
            assert_eq!(*key, format!("KEY_F{}", 13 + i as u32), "wrong key for position {}", i);
        }
    }

    // ---- validate_temp_path ----

    #[test]
    fn validate_temp_path_ok() {
        assert!(validate_temp_path("/tmp/conduit-ratbag-Abc123/logitech-g502-x.device").is_ok());
        assert!(validate_temp_path("/tmp/conduit-ratbag-AAAA/foo.device").is_ok());
        assert!(validate_temp_path("/tmp/conduit-ratbag-0000/x.device").is_ok());
    }

    #[test]
    fn validate_temp_path_rejects_bad_inputs() {
        // Uppercase in filename
        assert!(validate_temp_path("/tmp/conduit-ratbag-abc/UPPER.device").is_err());
        // Path traversal
        assert!(validate_temp_path("/tmp/conduit-ratbag-abc/../../etc/passwd").is_err());
        // Wrong prefix
        assert!(validate_temp_path("/etc/passwd").is_err());
        // Space in filename
        assert!(validate_temp_path("/tmp/conduit-ratbag-abc/a b.device").is_err());
        // Missing filename
        assert!(validate_temp_path("/tmp/conduit-ratbag-abc/").is_err());
        // Invalid rand part (contains -)
        assert!(validate_temp_path("/tmp/conduit-ratbag-ab-cd/foo.device").is_err());
    }

    // ---- parse_ratbagctl_list ----

    #[test]
    fn parse_ratbagctl_list_finds_g502() {
        let output = "logitech-g502-x-plus:usb:046d:c547:1  Logitech G502 X PLUS\n";
        let (id, name) = parse_ratbagctl_list(output);
        assert_eq!(id.as_deref(), Some("logitech-g502-x-plus:usb:046d:c547:1"));
        assert_eq!(name.as_deref(), Some("Logitech G502 X PLUS"));
    }

    #[test]
    fn parse_ratbagctl_list_returns_none_when_absent() {
        let output = "logitech-g603:usb:046d:c090:1  Logitech G603\n";
        let (id, name) = parse_ratbagctl_list(output);
        assert!(id.is_none());
        assert!(name.is_none());
    }
}
