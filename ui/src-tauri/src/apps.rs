use std::collections::HashSet;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde::Serialize;

/// Maximum file size (bytes) for reading icon data.
const MAX_ICON_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct InstalledApp {
    pub app_id: String,
    pub name: String,
    pub wm_class: Option<String>,
    pub categories: Vec<String>,
    /// data URI (image/png base64 or image/svg+xml;base64) or None.
    /// At parse time holds the raw Icon= value; resolved externally.
    pub icon: Option<String>,
}

/// Parse a .desktop file and return an `InstalledApp` with the raw (unresolved)
/// icon name/path, or `None` if the entry should be skipped.
pub fn parse_desktop_entry(text: &str, stem: &str) -> Option<InstalledApp> {
    let mut in_desktop_entry = false;
    let mut name: Option<String> = None;
    let mut icon: Option<String> = None;
    let mut wm_class: Option<String> = None;
    let mut categories: Vec<String> = Vec::new();
    let mut no_display = false;
    let mut entry_type: Option<String> = None;

    for line in text.lines() {
        let line = line.trim();

        // Section headers
        if line.starts_with('[') {
            if line == "[Desktop Entry]" {
                in_desktop_entry = true;
            } else {
                // Stop parsing once we leave [Desktop Entry]
                if in_desktop_entry {
                    break;
                }
            }
            continue;
        }

        if !in_desktop_entry {
            continue;
        }

        // Skip comments and blank lines
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        if let Some((key, value)) = line.split_once('=') {
            let key = key.trim();
            let value = value.trim();
            match key {
                "Name" if name.is_none() => name = Some(value.to_string()),
                "Icon" if icon.is_none() => icon = Some(value.to_string()),
                "StartupWMClass" if wm_class.is_none() => wm_class = Some(value.to_string()),
                "Categories" => {
                    categories = value
                        .split(';')
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string())
                        .collect();
                }
                "NoDisplay" => {
                    no_display = value.eq_ignore_ascii_case("true");
                }
                "Type" if entry_type.is_none() => entry_type = Some(value.to_string()),
                _ => {}
            }
        }
    }

    // Skip if NoDisplay or not Type=Application
    if no_display {
        return None;
    }
    if entry_type.as_deref() != Some("Application") {
        return None;
    }

    let name = name?;

    Some(InstalledApp {
        app_id: stem.to_string(),
        name,
        wm_class,
        categories,
        icon,
    })
}

/// Resolve a raw icon value to a data URI, or `None` if unresolvable.
///
/// - Absolute path → read directly (skip if > 512 KB).
/// - Theme name → probe hicolor then pixmaps candidates; first hit wins.
pub fn resolve_icon(raw: &str) -> Option<String> {
    if raw.starts_with('/') {
        // Absolute path
        read_icon_file(Path::new(raw))
    } else {
        // Theme name: try hicolor sizes then pixmaps
        let candidates = icon_candidates(raw);
        for candidate in &candidates {
            if let Some(data) = read_icon_file(candidate) {
                return Some(data);
            }
        }
        None
    }
}

/// Build the list of candidate icon paths for a theme name.
fn icon_candidates(name: &str) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    for size in &["128x128", "64x64", "48x48"] {
        paths.push(
            PathBuf::from(format!("/usr/share/icons/hicolor/{}/apps/{}.png", size, name)),
        );
    }
    paths.push(PathBuf::from(format!("/usr/share/pixmaps/{}.png", name)));
    paths.push(PathBuf::from(format!("/usr/share/pixmaps/{}.svg", name)));
    paths
}

/// Read an icon file and encode it as a data URI.
/// Returns `None` if the file doesn't exist, is too large, or has an unsupported extension.
fn read_icon_file(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_ICON_BYTES {
        return None;
    }

    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    let bytes = std::fs::read(path).ok()?;

    match ext.as_str() {
        "png" => {
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Some(format!("data:image/png;base64,{}", encoded))
        }
        "svg" => {
            let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
            Some(format!("data:image/svg+xml;base64,{}", encoded))
        }
        _ => None,
    }
}

/// Collect installed apps from the given directories.
///
/// - Iterates dirs in order; first occurrence of a stem wins (dedup).
/// - Skips unreadable dirs silently.
/// - Returns apps sorted by name (case-insensitive).
/// - Icons in the returned list are the raw Icon= values (caller resolves them).
pub fn list_installed_apps_impl(dirs: &[PathBuf]) -> Vec<InstalledApp> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut apps: Vec<InstalledApp> = Vec::new();

    for dir in dirs {
        let entries = match std::fs::read_dir(dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(ext) = path.extension() else { continue };
            if ext != "desktop" {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let stem = stem.to_string();
            if seen.contains(&stem) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Some(app) = parse_desktop_entry(&text, &stem) {
                seen.insert(stem);
                apps.push(app);
            }
        }
    }

    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIREFOX: &str = "[Desktop Entry]\nType=Application\nName=Firefox\nIcon=firefox\nStartupWMClass=firefox\nCategories=Network;WebBrowser;\n";

    #[test]
    fn parses_a_desktop_entry() {
        let app = parse_desktop_entry(FIREFOX, "org.mozilla.firefox").unwrap();
        assert_eq!(app.name, "Firefox");
        assert_eq!(app.app_id, "org.mozilla.firefox");
        assert_eq!(app.wm_class.as_deref(), Some("firefox"));
        assert!(app.categories.iter().any(|c| c == "WebBrowser"));
        assert_eq!(app.icon.as_deref(), Some("firefox")); // unresolved at parse stage
    }

    #[test]
    fn skips_nodisplay_and_non_applications() {
        assert!(parse_desktop_entry("[Desktop Entry]\nType=Application\nName=X\nNoDisplay=true\n", "x").is_none());
        assert!(parse_desktop_entry("[Desktop Entry]\nType=Link\nName=X\n", "x").is_none());
    }

    #[test]
    fn list_dedups_by_stem_first_dir_wins_and_sorts() {
        let t = std::env::temp_dir().join(format!("conduit-apps-{}", std::process::id()));
        let (a, b) = (t.join("a"), t.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("zed.desktop"), "[Desktop Entry]\nType=Application\nName=Zed A\n").unwrap();
        std::fs::write(b.join("zed.desktop"), "[Desktop Entry]\nType=Application\nName=Zed B\n").unwrap();
        std::fs::write(b.join("alpha.desktop"), "[Desktop Entry]\nType=Application\nName=Alpha\n").unwrap();
        let apps = list_installed_apps_impl(&[a, b]);
        assert_eq!(apps.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["Alpha", "Zed A"]);
        std::fs::remove_dir_all(&t).ok();
    }
}
