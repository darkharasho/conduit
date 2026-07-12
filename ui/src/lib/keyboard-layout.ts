/**
 * ANSI TKL keyboard layout plus a mouse-button row.
 *
 * Key `name` values are the canonical daemon key-name strings from
 * crates/conduit-core/src/keys.rs (the KEYS table).  Any change there must be
 * reflected here.
 *
 * Width is in "u" units (1u = one standard key width).  The standard ANSI TKL
 * rows each sum to 15u.  The mouse row is exempt from that constraint.
 */

export interface KeyCap {
  /** Canonical daemon key name (must match keys.rs KEYS table) */
  name: string;
  /** Human-readable label shown on the key cap */
  label: string;
  /** Width in u units (1 | 1.5 | 1.75 | 2 | 2.25 | 2.75 | 6.25) */
  width: number;
}

/**
 * ANSI_LAYOUT rows:
 *   [0]  Esc + F1-F12 row  (15u total)
 *   [1]  Number row        (15u total)
 *   [2]  QWERTY row        (15u total)
 *   [3]  Home row (ASDF)   (15u total)
 *   [4]  Bottom row (ZXCV) (15u total)
 *   [5]  Mouse buttons     (exempt from 15u rule)
 *
 * Navigation cluster (Home/End/PgUp/PgDn/arrows) is deliberately omitted from
 * the main grid in v1 to keep the layout simple; nav keys can be added in a
 * future iteration.
 */
export const ANSI_LAYOUT: KeyCap[][] = [
  // Row 0: Esc + F-key row
  // Standard ANSI TKL: Esc(1) gap(1) F1-F4(4×1) gap(0.5) F5-F8(4×1) gap(0.5) F9-F12(4×1)
  // = 1 + 1 + 4 + 0.5 + 4 + 0.5 + 4 = 15u
  // We model the gaps by giving Esc extra width so the grid sums cleanly to 15u:
  // Esc(3) F1-F12(12×1) = 15u
  [
    { name: "esc",  label: "Esc",  width: 3 },
    { name: "f1",   label: "F1",   width: 1 },
    { name: "f2",   label: "F2",   width: 1 },
    { name: "f3",   label: "F3",   width: 1 },
    { name: "f4",   label: "F4",   width: 1 },
    { name: "f5",   label: "F5",   width: 1 },
    { name: "f6",   label: "F6",   width: 1 },
    { name: "f7",   label: "F7",   width: 1 },
    { name: "f8",   label: "F8",   width: 1 },
    { name: "f9",   label: "F9",   width: 1 },
    { name: "f10",  label: "F10",  width: 1 },
    { name: "f11",  label: "F11",  width: 1 },
    { name: "f12",  label: "F12",  width: 1 },
  ],
  // Row 1: Number row
  // ` 1 2 3 4 5 6 7 8 9 0 - = Backspace
  // 1+1+1+1+1+1+1+1+1+1+1+1+1+2 = 15u
  [
    { name: "grave",     label: "`",         width: 1 },
    { name: "1",         label: "1",         width: 1 },
    { name: "2",         label: "2",         width: 1 },
    { name: "3",         label: "3",         width: 1 },
    { name: "4",         label: "4",         width: 1 },
    { name: "5",         label: "5",         width: 1 },
    { name: "6",         label: "6",         width: 1 },
    { name: "7",         label: "7",         width: 1 },
    { name: "8",         label: "8",         width: 1 },
    { name: "9",         label: "9",         width: 1 },
    { name: "0",         label: "0",         width: 1 },
    { name: "minus",     label: "-",         width: 1 },
    { name: "equal",     label: "=",         width: 1 },
    { name: "backspace", label: "⌫",        width: 2 },
  ],
  // Row 2: QWERTY row
  // Tab(1.5) Q W E R T Y U I O P [ ] \(1.5) = 1.5+1*12+1.5 = 15u
  [
    { name: "tab",        label: "Tab",  width: 1.5 },
    { name: "q",          label: "Q",    width: 1 },
    { name: "w",          label: "W",    width: 1 },
    { name: "e",          label: "E",    width: 1 },
    { name: "r",          label: "R",    width: 1 },
    { name: "t",          label: "T",    width: 1 },
    { name: "y",          label: "Y",    width: 1 },
    { name: "u",          label: "U",    width: 1 },
    { name: "i",          label: "I",    width: 1 },
    { name: "o",          label: "O",    width: 1 },
    { name: "p",          label: "P",    width: 1 },
    { name: "leftbrace",  label: "[",    width: 1 },
    { name: "rightbrace", label: "]",    width: 1 },
    { name: "backslash",  label: "\\",   width: 1.5 },
  ],
  // Row 3: Home row
  // CapsLock(1.75) A S D F G H J K L ; ' Enter(2.25) = 1.75+1*11+2.25 = 15u
  [
    { name: "capslock",   label: "Caps",  width: 1.75 },
    { name: "a",          label: "A",     width: 1 },
    { name: "s",          label: "S",     width: 1 },
    { name: "d",          label: "D",     width: 1 },
    { name: "f",          label: "F",     width: 1 },
    { name: "g",          label: "G",     width: 1 },
    { name: "h",          label: "H",     width: 1 },
    { name: "j",          label: "J",     width: 1 },
    { name: "k",          label: "K",     width: 1 },
    { name: "l",          label: "L",     width: 1 },
    { name: "semicolon",  label: ";",     width: 1 },
    { name: "apostrophe", label: "'",     width: 1 },
    { name: "enter",      label: "↵",    width: 2.25 },
  ],
  // Row 4: Bottom row (Shift row)
  // LShift(2.25) Z X C V B N M , . / RShift(2.75) = 2.25+1*10+2.75 = 15u
  [
    { name: "leftshift",  label: "⇧",    width: 2.25 },
    { name: "z",          label: "Z",     width: 1 },
    { name: "x",          label: "X",     width: 1 },
    { name: "c",          label: "C",     width: 1 },
    { name: "v",          label: "V",     width: 1 },
    { name: "b",          label: "B",     width: 1 },
    { name: "n",          label: "N",     width: 1 },
    { name: "m",          label: "M",     width: 1 },
    { name: "comma",      label: ",",     width: 1 },
    { name: "dot",        label: ".",     width: 1 },
    { name: "slash",      label: "/",     width: 1 },
    { name: "rightshift", label: "⇧",    width: 2.75 },
  ],
  // Row 5: Modifier + space row
  // LCtrl(1.25) LMeta(1.25) LAlt(1.25) Space(6.25) RAlt(1.25) RMeta(1.25) Compose(1.25) RCtrl(1.25) = 15u
  [
    { name: "leftctrl",  label: "Ctrl",    width: 1.25 },
    { name: "leftmeta",  label: "⌘",      width: 1.25 },
    { name: "leftalt",   label: "Alt",     width: 1.25 },
    { name: "space",     label: "Space",   width: 6.25 },
    { name: "rightalt",  label: "AltGr",   width: 1.25 },
    { name: "rightmeta", label: "⌘",      width: 1.25 },
    { name: "compose",   label: "Menu",    width: 1.25 },
    { name: "rightctrl", label: "Ctrl",    width: 1.25 },
  ],
];

/** Canonical daemon key names, copied from crates/conduit-core/src/keys.rs KEYS table. */
export const VALID_KEY_NAMES: ReadonlySet<string> = new Set([
  "esc", "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
  "minus", "equal", "backspace", "tab", "q", "w", "e", "r", "t", "y",
  "u", "i", "o", "p", "leftbrace", "rightbrace", "enter", "leftctrl",
  "a", "s", "d", "f", "g", "h", "j", "k", "l", "semicolon", "apostrophe",
  "grave", "leftshift", "backslash", "z", "x", "c", "v", "b", "n", "m",
  "comma", "dot", "slash", "rightshift", "kpasterisk", "leftalt", "space",
  "capslock", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10",
  "f11", "f12", "rightctrl", "rightalt", "home", "up", "pageup", "left",
  "right", "end", "down", "pagedown", "insert", "delete", "mute",
  "volumedown", "volumeup", "leftmeta", "rightmeta", "compose", "back",
  "forward", "print", "btn_left", "btn_right", "btn_middle", "mouse4", "mouse5",
  "btn_forward", "btn_back", "btn_task",
  "wheelup", "wheeldown", "wheelleft", "wheelright",
]);
