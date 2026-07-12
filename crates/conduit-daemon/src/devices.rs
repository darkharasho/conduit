use std::path::PathBuf;
use conduit_core::config::Settings;

/// A discovered input device with its classification.
#[derive(Debug, Clone)]
pub struct Discovered {
    pub path: PathBuf,
    pub name: String,
    pub vendor: u16,
    pub product: u16,
    pub is_keyboard: bool,
    pub is_mouse: bool,
}

/// Probe a single device path and return a `Discovered` entry, or `None` if the
/// device cannot be opened / read (e.g. permission error or not an input device)
/// or if it is a Conduit Virtual device.
pub fn probe(path: PathBuf) -> Option<Discovered> {
    let dev = evdev::Device::open(&path).ok()?;

    let name = dev.name().unwrap_or("").to_owned();

    // Exclude Conduit Virtual devices at discovery time.
    if name.starts_with("Conduit Virtual") {
        return None;
    }

    let id = dev.input_id();
    let vendor = id.vendor();
    let product = id.product();

    // Classification:
    //   keyboard = supports EV_KEY and has KEY_A
    //   mouse    = supports EV_KEY with BTN_LEFT and EV_REL
    let supported_keys = dev.supported_keys();
    let has_ev_key = supported_keys.is_some();
    let has_key_a = supported_keys
        .as_ref()
        .map_or(false, |keys| keys.contains(evdev::Key::KEY_A));
    let has_btn_left = supported_keys
        .as_ref()
        .map_or(false, |keys| keys.contains(evdev::Key::BTN_LEFT));
    let has_ev_rel = dev
        .supported_relative_axes()
        .is_some();

    let is_keyboard = has_ev_key && has_key_a;
    let is_mouse = has_ev_key && has_btn_left && has_ev_rel;

    Some(Discovered {
        path,
        name,
        vendor,
        product,
        is_keyboard,
        is_mouse,
    })
}

/// Enumerate all input devices under `/dev/input/event*` and classify each one.
/// Devices whose name starts with `"Conduit Virtual"` are excluded.
pub fn discover() -> anyhow::Result<Vec<Discovered>> {
    let mut results = Vec::new();

    for (path, _dev) in evdev::enumerate() {
        if let Some(d) = probe(path) {
            results.push(d);
        }
    }

    Ok(results)
}

/// Determine whether a discovered device should be grabbed based on the loaded
/// `Settings`.
///
/// Rules:
/// - Any device whose name starts with `"Conduit Virtual"` → `false` (defense in depth).
/// - Keyboards: grabbed if `grab_all_keyboards` is set, or if the device name
///   appears in `grab_keyboards`.
/// - Mice: grabbed if the device name appears in `grab_mice` (exact match).
/// - Devices that are neither keyboard nor mouse → `false`.
pub fn should_grab(d: &Discovered, s: &Settings) -> bool {
    // Defense in depth: never grab Conduit Virtual devices.
    if d.name.starts_with("Conduit Virtual") {
        return false;
    }

    let mut grab = false;

    if d.is_keyboard {
        if s.grab_all_keyboards || s.grab_keyboards.iter().any(|k| k == &d.name) {
            grab = true;
        }
    }

    if d.is_mouse {
        if s.grab_mice.iter().any(|m| m == &d.name) {
            grab = true;
        }
    }

    grab
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn kbd(name: &str) -> Discovered {
        Discovered {
            path: "/dev/input/event0".into(),
            name: name.into(),
            vendor: 0,
            product: 0,
            is_keyboard: true,
            is_mouse: false,
        }
    }

    fn mouse(name: &str) -> Discovered {
        Discovered {
            path: "/dev/input/event1".into(),
            name: name.into(),
            vendor: 0,
            product: 0,
            is_keyboard: false,
            is_mouse: true,
        }
    }

    fn test_settings() -> conduit_core::config::Settings {
        conduit_core::config::compile(
            "[devices]\ngrab_all_keyboards = true\ngrab_mice = [\"Logitech G502\"]",
        )
        .unwrap()
        .settings
    }

    #[test]
    fn grab_selection_rules() {
        let s = test_settings();
        assert!(should_grab(&kbd("AT Translated Set 2 keyboard"), &s));
        assert!(!should_grab(&mouse("Some Mouse"), &s));
        assert!(should_grab(&mouse("Logitech G502"), &s));
        assert!(!should_grab(&kbd("Conduit Virtual Keyboard"), &s)); // never
    }

    #[test]
    fn grab_keyboard_by_exact_name() {
        let s = conduit_core::config::compile(
            "[devices]\ngrab_all_keyboards = false\ngrab_keyboards = [\"My Keyboard\"]",
        )
        .unwrap()
        .settings;
        assert!(should_grab(&kbd("My Keyboard"), &s));
        assert!(!should_grab(&kbd("Other Keyboard"), &s));
    }

    #[test]
    fn conduit_virtual_devices_never_grabbed() {
        let s = conduit_core::config::compile(
            "[devices]\ngrab_all_keyboards = true\ngrab_mice = [\"Conduit Virtual Mouse\"]",
        )
        .unwrap()
        .settings;
        assert!(!should_grab(&kbd("Conduit Virtual Keyboard"), &s));
        assert!(!should_grab(&mouse("Conduit Virtual Mouse"), &s));
    }

    #[test]
    fn non_keyboard_non_mouse_not_grabbed() {
        let s = test_settings();
        let other = Discovered {
            path: "/dev/input/event2".into(),
            name: "Generic HID device".into(),
            vendor: 0,
            product: 0,
            is_keyboard: false,
            is_mouse: false,
        };
        assert!(!should_grab(&other, &s));
    }
}
