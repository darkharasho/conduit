//! Pure device classification and grab-list selector matching.
//!
//! `classify` looks only at capability sets (no device I/O) so it is fully
//! unit-testable; `devices::probe` builds a `Caps` from a live evdev device.

const BTN_LEFT: u16 = 0x110;
const BTN_JOYSTICK_FIRST: u16 = 0x120; // BTN_TRIGGER
const BTN_JOYSTICK_LAST: u16 = 0x12f;
const BTN_GAMEPAD_FIRST: u16 = 0x130; // BTN_SOUTH
const BTN_GAMEPAD_LAST: u16 = 0x13e;
const BTN_TOUCH: u16 = 0x14a;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceClass {
    Keyboard,
    Mouse,
    Touchpad,
    Gamepad,
    MediaKeys,
    Other,
}

impl DeviceClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            DeviceClass::Keyboard => "keyboard",
            DeviceClass::Mouse => "mouse",
            DeviceClass::Touchpad => "touchpad",
            DeviceClass::Gamepad => "gamepad",
            DeviceClass::MediaKeys => "media",
            DeviceClass::Other => "other",
        }
    }
}

/// Capability summary of an input device node.
#[derive(Debug, Default, Clone)]
pub struct Caps {
    /// Supported EV_KEY codes.
    pub keys: Vec<u16>,
    /// Has both REL_X and REL_Y.
    pub rel_x_y: bool,
    /// Has both ABS_X and ABS_Y.
    pub abs_x_y: bool,
    /// INPUT_PROP_POINTER set.
    pub prop_pointer: bool,
}

/// Classify a device node from its capabilities. First match wins:
/// Touchpad → Gamepad → Mouse → Keyboard (≥20 typing keys) → MediaKeys → Other.
pub fn classify(c: &Caps) -> DeviceClass {
    let has = |code: u16| c.keys.contains(&code);
    if c.abs_x_y && (has(BTN_TOUCH) || c.prop_pointer) {
        return DeviceClass::Touchpad;
    }
    if c.keys.iter().any(|k| (BTN_GAMEPAD_FIRST..=BTN_GAMEPAD_LAST).contains(k))
        || c.keys.iter().any(|k| (BTN_JOYSTICK_FIRST..=BTN_JOYSTICK_LAST).contains(k))
    {
        return DeviceClass::Gamepad;
    }
    if c.rel_x_y && has(BTN_LEFT) {
        return DeviceClass::Mouse;
    }
    // Typing keys: ESC(1)..CAPSLOCK(58) block — letters, digits, punctuation,
    // enter, space. Consumer/System Control nodes declare media keys outside
    // this block and stay below the threshold.
    let typing = c.keys.iter().filter(|k| (1..=58).contains(*k)).count();
    if typing >= 20 {
        return DeviceClass::Keyboard;
    }
    if !c.keys.is_empty() {
        return DeviceClass::MediaKeys;
    }
    DeviceClass::Other
}

/// One entry in `grab_keyboards` / `grab_mice` or a `profile.*.device` key.
///
/// Grammar (back-compat: anything unparseable is a plain name):
/// - `"AT Translated Set 2 keyboard"` — exact name
/// - `"046d:c24a"` — vendor:product hex
/// - `"046d:c24a/Logitech Gaming Mouse G600 Keyboard"` — vendor:product/name
/// - `"046d:c24a/G600@usb-0000:00:14.0-1/input0"` — plus physical port path,
///   for telling identical devices apart. The `@phys` suffix is recognized
///   only when the prefix parses as `vid:pid` or `vid:pid/name`; plain names
///   containing `@` stay plain names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectorBase {
    Name(String),
    VidPid(u16, u16),
    VidPidName(u16, u16, String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceSelector {
    pub base: SelectorBase,
    pub phys: Option<String>,
}

fn parse_vid_pid(s: &str) -> Option<(u16, u16)> {
    let (v, p) = s.split_once(':')?;
    if v.len() != 4 || p.len() != 4 {
        return None;
    }
    Some((u16::from_str_radix(v, 16).ok()?, u16::from_str_radix(p, 16).ok()?))
}

fn parse_base(s: &str) -> SelectorBase {
    if let Some((vp, name)) = s.split_once('/') {
        if let Some((v, p)) = parse_vid_pid(vp) {
            return SelectorBase::VidPidName(v, p, name.to_string());
        }
    }
    if let Some((v, p)) = parse_vid_pid(s) {
        return SelectorBase::VidPid(v, p);
    }
    SelectorBase::Name(s.to_string())
}

impl DeviceSelector {
    pub fn parse(s: &str) -> DeviceSelector {
        if let Some((prefix, phys)) = s.rsplit_once('@') {
            let base = parse_base(prefix);
            if !matches!(base, SelectorBase::Name(_)) {
                return DeviceSelector { base, phys: Some(phys.to_string()) };
            }
        }
        DeviceSelector { base: parse_base(s), phys: None }
    }

    pub fn matches(&self, name: &str, vendor: u16, product: u16, phys: &str) -> bool {
        let base_ok = match &self.base {
            SelectorBase::Name(n) => n == name,
            SelectorBase::VidPid(v, p) => *v == vendor && *p == product,
            SelectorBase::VidPidName(v, p, n) => *v == vendor && *p == product && n == name,
        };
        base_ok && self.phys.as_ref().map_or(true, |ph| ph == phys)
    }

    /// Match strength for picking the best section when several apply:
    /// `vid:pid/name@phys` (4) > `vid:pid/name` (3) > name (2) > `vid:pid` (1).
    pub fn specificity(&self) -> u8 {
        match (&self.base, &self.phys) {
            (SelectorBase::VidPidName(..), Some(_)) | (SelectorBase::VidPid(..), Some(_)) => 4,
            (SelectorBase::VidPidName(..), None) => 3,
            (SelectorBase::Name(_), _) => 2,
            (SelectorBase::VidPid(..), None) => 1,
        }
    }
}

/// Most specific matching selector's index (= device slot); ties → first in
/// config order. `None` when nothing matches.
pub fn resolve_slot(
    name: &str,
    vendor: u16,
    product: u16,
    phys: &str,
    selectors: &[String],
) -> Option<u16> {
    selectors
        .iter()
        .enumerate()
        .filter_map(|(i, s)| {
            let sel = DeviceSelector::parse(s);
            sel.matches(name, vendor, product, phys).then(|| (i, sel.specificity()))
        })
        .max_by_key(|&(i, spec)| (spec, std::cmp::Reverse(i)))
        .map(|(i, _)| i as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(keys: Vec<u16>, rel_x_y: bool, abs_x_y: bool, prop_pointer: bool) -> Caps {
        Caps { keys, rel_x_y, abs_x_y, prop_pointer }
    }
    fn typing_keys() -> Vec<u16> {
        (1..=58).collect()
    }

    // Modeled on the real machine inventory (see spec).
    #[test]
    fn wooting_main_node_is_keyboard() {
        assert_eq!(classify(&caps(typing_keys(), false, false, false)), DeviceClass::Keyboard);
    }
    #[test]
    fn wooting_mouse_node_is_mouse() {
        assert_eq!(classify(&caps(vec![0x110, 0x111, 0x112], true, false, false)), DeviceClass::Mouse);
    }
    #[test]
    fn consumer_control_node_is_media_not_keyboard() {
        // Volume/media keys only (KEY_MUTE=113, VOLUP=115, PLAYPAUSE=164...).
        assert_eq!(
            classify(&caps(vec![113, 114, 115, 163, 164, 165], false, false, false)),
            DeviceClass::MediaKeys
        );
    }
    #[test]
    fn power_button_is_media() {
        assert_eq!(classify(&caps(vec![116], false, false, false)), DeviceClass::MediaKeys);
    }
    #[test]
    fn touchpad_is_touchpad_not_mouse() {
        assert_eq!(classify(&caps(vec![0x110, 0x14a], true, true, true)), DeviceClass::Touchpad);
    }
    #[test]
    fn gamepad_detected_before_mouse() {
        assert_eq!(classify(&caps(vec![0x110, 0x130, 0x131], true, false, false)), DeviceClass::Gamepad);
    }
    #[test]
    fn no_keys_no_axes_is_other() {
        assert_eq!(classify(&caps(vec![], false, false, false)), DeviceClass::Other);
    }

    fn name_sel(s: &str) -> DeviceSelector {
        DeviceSelector { base: SelectorBase::Name(s.into()), phys: None }
    }

    #[test]
    fn selector_parse_forms() {
        assert_eq!(DeviceSelector::parse("My Kbd"), name_sel("My Kbd"));
        assert_eq!(
            DeviceSelector::parse("046d:c24a"),
            DeviceSelector { base: SelectorBase::VidPid(0x046d, 0xc24a), phys: None }
        );
        assert_eq!(
            DeviceSelector::parse("046d:c24a/G600 Keyboard"),
            DeviceSelector {
                base: SelectorBase::VidPidName(0x046d, 0xc24a, "G600 Keyboard".into()),
                phys: None
            }
        );
        // Not hex / wrong width → plain name (back-compat).
        assert_eq!(DeviceSelector::parse("46d:c24a"), name_sel("46d:c24a"));
        assert_eq!(DeviceSelector::parse("zzzz:c24a"), name_sel("zzzz:c24a"));
        // Name containing '/' without a vid:pid prefix stays a name.
        assert_eq!(DeviceSelector::parse("Foo/Bar"), name_sel("Foo/Bar"));
    }

    #[test]
    fn selector_matching() {
        assert!(DeviceSelector::parse("046d:c24a").matches("anything", 0x046d, 0xc24a, ""));
        assert!(!DeviceSelector::parse("046d:c24a").matches("anything", 0x046d, 0xc24b, ""));
        assert!(DeviceSelector::parse("046d:c24a/G600").matches("G600", 0x046d, 0xc24a, ""));
        assert!(!DeviceSelector::parse("046d:c24a/G600").matches("Other", 0x046d, 0xc24a, ""));
        assert!(DeviceSelector::parse("G600").matches("G600", 0, 0, ""));
    }

    #[test]
    fn selector_phys_suffix() {
        let s = DeviceSelector::parse("046d:c24a/G600@usb-1/input0");
        assert!(s.matches("G600", 0x046d, 0xc24a, "usb-1/input0"));
        assert!(!s.matches("G600", 0x046d, 0xc24a, "usb-2/input0"));
        assert_eq!(s.specificity(), 4);
        // '@' after a plain name is NOT a phys suffix
        let n = DeviceSelector::parse("Weird@Name");
        assert_eq!(n, name_sel("Weird@Name"));
        assert!(n.matches("Weird@Name", 0, 0, ""));
        // vid:pid@phys works too
        let vp = DeviceSelector::parse("046d:c24a@usb-1/input0");
        assert!(vp.matches("anything", 0x046d, 0xc24a, "usb-1/input0"));
        assert!(!vp.matches("anything", 0x046d, 0xc24a, ""));
    }

    #[test]
    fn specificity_ranking() {
        assert_eq!(DeviceSelector::parse("046d:c24a/G600@p").specificity(), 4);
        assert_eq!(DeviceSelector::parse("046d:c24a/G600").specificity(), 3);
        assert_eq!(DeviceSelector::parse("G600").specificity(), 2);
        assert_eq!(DeviceSelector::parse("046d:c24a").specificity(), 1);
    }

    #[test]
    fn resolve_slot_prefers_specific_then_first() {
        let sels = vec![
            "046d:c24a".to_string(),            // 0: spec 1
            "G600".to_string(),                 // 1: spec 2
            "046d:c24a/G600".to_string(),       // 2: spec 3
            "046d:c24a/G600@usb-1".to_string(), // 3: spec 4
        ];
        assert_eq!(resolve_slot("G600", 0x046d, 0xc24a, "usb-1", &sels), Some(3));
        assert_eq!(resolve_slot("G600", 0x046d, 0xc24a, "usb-2", &sels), Some(2)); // phys mismatch → next
        assert_eq!(resolve_slot("Other", 0x046d, 0xc24a, "", &sels), Some(0));
        assert_eq!(resolve_slot("Nope", 1, 1, "", &sels), None);
        // tie on specificity → first in config order
        let tie = vec![
            "046d:c24a/G600".to_string(),
            "046d:c24a/G601".to_string(),
            "046d:c24a/G600".to_string(),
        ];
        assert_eq!(resolve_slot("G600", 0x046d, 0xc24a, "", &tie), Some(0));
    }
}
