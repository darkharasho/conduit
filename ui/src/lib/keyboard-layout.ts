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

/**
 * (name, evdev code) pairs, copied from crates/conduit-core/src/keys.rs KEYS.
 * Used to label device-declared key codes and to check whether a board key
 * exists on a given device.
 */
export const KEY_CODES: ReadonlyArray<readonly [string, number]> = [
  ["esc", 1], ["1", 2], ["2", 3], ["3", 4], ["4", 5], ["5", 6], ["6", 7],
  ["7", 8], ["8", 9], ["9", 10], ["0", 11], ["minus", 12], ["equal", 13],
  ["backspace", 14], ["tab", 15], ["q", 16], ["w", 17], ["e", 18], ["r", 19],
  ["t", 20], ["y", 21], ["u", 22], ["i", 23], ["o", 24], ["p", 25],
  ["leftbrace", 26], ["rightbrace", 27], ["enter", 28], ["leftctrl", 29],
  ["a", 30], ["s", 31], ["d", 32], ["f", 33], ["g", 34], ["h", 35], ["j", 36],
  ["k", 37], ["l", 38], ["semicolon", 39], ["apostrophe", 40], ["grave", 41],
  ["leftshift", 42], ["backslash", 43], ["z", 44], ["x", 45], ["c", 46],
  ["v", 47], ["b", 48], ["n", 49], ["m", 50], ["comma", 51], ["dot", 52],
  ["slash", 53], ["rightshift", 54], ["kpasterisk", 55], ["leftalt", 56],
  ["space", 57], ["capslock", 58],
  ["f1", 59], ["f2", 60], ["f3", 61], ["f4", 62], ["f5", 63], ["f6", 64],
  ["f7", 65], ["f8", 66], ["f9", 67], ["f10", 68], ["f11", 87], ["f12", 88],
  ["numlock", 69], ["kp7", 71], ["kp8", 72], ["kp9", 73], ["kpminus", 74],
  ["kp4", 75], ["kp5", 76], ["kp6", 77], ["kpplus", 78], ["kp1", 79],
  ["kp2", 80], ["kp3", 81], ["kp0", 82], ["kpdot", 83], ["kpenter", 96],
  ["kpslash", 98],
  ["rightctrl", 97], ["rightalt", 100], ["home", 102], ["up", 103],
  ["pageup", 104], ["left", 105], ["right", 106], ["end", 107], ["down", 108],
  ["pagedown", 109], ["insert", 110], ["delete", 111], ["mute", 113],
  ["volumedown", 114], ["volumeup", 115], ["leftmeta", 125], ["rightmeta", 126],
  ["compose", 127], ["back", 158], ["forward", 159],
  ["nextsong", 163], ["playpause", 164], ["previoussong", 165],
  ["print", 210],
  ["btn_left", 272], ["btn_right", 273], ["btn_middle", 274],
  ["mouse4", 275], ["mouse5", 276],
  ["btn_forward", 277], ["btn_back", 278], ["btn_task", 279],
  ["wheelup", 760], ["wheeldown", 761], ["wheelleft", 762], ["wheelright", 763],
];

const CODE_TO_NAME = new Map<number, string>(KEY_CODES.map(([n, c]) => [c, n]));
const NAME_TO_CODE = new Map<string, number>(KEY_CODES.map(([n, c]) => [n, c]));

/** Canonical name for an evdev code; `key:N` fallback matches the daemon. */
export function keyNameForCode(code: number): string {
  return CODE_TO_NAME.get(code) ?? `key:${code}`;
}

/** Evdev code for a canonical name (or `key:N`); null when unknown. */
export function codeForKeyName(name: string): number | null {
  if (name.startsWith("key:")) {
    const n = parseInt(name.slice(4), 10);
    return Number.isNaN(n) ? null : n;
  }
  return NAME_TO_CODE.get(name) ?? null;
}

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
  "forward", "nextsong", "playpause", "previoussong",
  "print", "btn_left", "btn_right", "btn_middle", "mouse4", "mouse5",
  "btn_forward", "btn_back", "btn_task",
  "wheelup", "wheeldown", "wheelleft", "wheelright",
]);
