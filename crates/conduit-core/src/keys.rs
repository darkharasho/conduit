use crate::event::Key;

// (name, evdev code). Canonical name first; aliases resolve in from_name only.
static KEYS: &[(&str, u16)] = &[
    ("esc", 1), ("1", 2), ("2", 3), ("3", 4), ("4", 5), ("5", 6), ("6", 7),
    ("7", 8), ("8", 9), ("9", 10), ("0", 11), ("minus", 12), ("equal", 13),
    ("backspace", 14), ("tab", 15), ("q", 16), ("w", 17), ("e", 18), ("r", 19),
    ("t", 20), ("y", 21), ("u", 22), ("i", 23), ("o", 24), ("p", 25),
    ("leftbrace", 26), ("rightbrace", 27), ("enter", 28), ("leftctrl", 29),
    ("a", 30), ("s", 31), ("d", 32), ("f", 33), ("g", 34), ("h", 35), ("j", 36),
    ("k", 37), ("l", 38), ("semicolon", 39), ("apostrophe", 40), ("grave", 41),
    ("leftshift", 42), ("backslash", 43), ("z", 44), ("x", 45), ("c", 46),
    ("v", 47), ("b", 48), ("n", 49), ("m", 50), ("comma", 51), ("dot", 52),
    ("slash", 53), ("rightshift", 54), ("kpasterisk", 55), ("leftalt", 56),
    ("space", 57), ("capslock", 58),
    ("f1", 59), ("f2", 60), ("f3", 61), ("f4", 62), ("f5", 63), ("f6", 64),
    ("f7", 65), ("f8", 66), ("f9", 67), ("f10", 68), ("f11", 87), ("f12", 88),
    // Numpad — G600-style MMO mice emit these from their keyboard node.
    ("numlock", 69), ("kp7", 71), ("kp8", 72), ("kp9", 73), ("kpminus", 74),
    ("kp4", 75), ("kp5", 76), ("kp6", 77), ("kpplus", 78), ("kp1", 79),
    ("kp2", 80), ("kp3", 81), ("kp0", 82), ("kpdot", 83), ("kpenter", 96),
    ("kpslash", 98),
    ("rightctrl", 97), ("rightalt", 100), ("home", 102), ("up", 103),
    ("pageup", 104), ("left", 105), ("right", 106), ("end", 107), ("down", 108),
    ("pagedown", 109), ("insert", 110), ("delete", 111), ("mute", 113),
    ("volumedown", 114), ("volumeup", 115), ("leftmeta", 125), ("rightmeta", 126),
    ("compose", 127), ("back", 158), ("forward", 159), ("print", 210),
    ("btn_left", 272), ("btn_right", 273), ("btn_middle", 274),
    ("mouse4", 275), ("mouse5", 276), // BTN_SIDE / BTN_EXTRA — canonical UI names
    ("btn_forward", 277), ("btn_back", 278), ("btn_task", 279),
    // Wheel pseudo-keys: unassigned evdev codes used internally so scroll
    // ticks can flow through the engine as ordinary key events.
    ("wheelup", 760), ("wheeldown", 761), ("wheelleft", 762), ("wheelright", 763),
];

static ALIASES: &[(&str, &str)] = &[
    ("escape", "esc"), ("return", "enter"), ("btn_side", "mouse4"),
    ("btn_extra", "mouse5"), ("ctrl", "leftctrl"), ("alt", "leftalt"),
    ("shift", "leftshift"), ("meta", "leftmeta"), ("super", "leftmeta"),
];

pub fn from_name(name: &str) -> Option<Key> {
    let name = name.to_ascii_lowercase();
    let canonical = ALIASES.iter().find(|(a, _)| *a == name).map(|(_, c)| *c).unwrap_or(&name);
    if let Some(code) = canonical.strip_prefix("key:") {
        return code.parse::<u16>().ok().map(Key);
    }
    KEYS.iter().find(|(n, _)| *n == canonical).map(|(_, c)| Key(*c))
}

pub fn name(key: Key) -> String {
    KEYS.iter()
        .find(|(_, c)| *c == key.0)
        .map(|(n, _)| n.to_string())
        .unwrap_or_else(|| format!("key:{}", key.0))
}

pub fn is_mouse_button(key: Key) -> bool {
    (0x110..=0x117).contains(&key.0) // BTN_LEFT..BTN_TASK
}

pub const WHEEL_UP: Key = Key(760);
pub const WHEEL_DOWN: Key = Key(761);
pub const WHEEL_LEFT: Key = Key(762);
pub const WHEEL_RIGHT: Key = Key(763);

pub fn is_wheel(key: Key) -> bool {
    (760..=763).contains(&key.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::Key;

    #[test]
    fn known_names_round_trip() {
        for name in ["esc", "a", "capslock", "leftctrl", "f12", "mouse4", "btn_left", "space"] {
            let k = from_name(name).expect(name);
            assert_eq!(super::name(k), name);
        }
    }

    #[test]
    fn numeric_fallback() {
        assert_eq!(from_name("key:700"), Some(Key(700)));
        assert_eq!(name(Key(700)), "key:700");
    }

    #[test]
    fn unknown_name_is_none() {
        assert_eq!(from_name("notakey"), None);
    }

    #[test]
    fn wheel_and_button_names_round_trip() {
        for name in ["btn_forward", "btn_back", "btn_task", "wheelup", "wheeldown", "wheelleft", "wheelright"] {
            let k = from_name(name).expect(name);
            assert_eq!(super::name(k), name);
        }
    }

    #[test]
    fn wheel_consts_and_predicate() {
        assert_eq!(from_name("wheelup"), Some(WHEEL_UP));
        assert_eq!(from_name("wheeldown"), Some(WHEEL_DOWN));
        assert_eq!(from_name("wheelleft"), Some(WHEEL_LEFT));
        assert_eq!(from_name("wheelright"), Some(WHEEL_RIGHT));
        for k in [WHEEL_UP, WHEEL_DOWN, WHEEL_LEFT, WHEEL_RIGHT] {
            assert!(is_wheel(k));
            assert!((k.0 as usize) < crate::config::KEY_TABLE_SIZE);
        }
        assert!(!is_wheel(Key(30)));
        assert!(!is_wheel(Key(272)));
    }
}
