/**
 * action-labels.ts
 *
 * Plain-language presentation for keys and actions. The daemon speaks evdev
 * names ("mouse4", "volumeup"); users see what a button does ("Back button",
 * "Volume up"). All lookups are pure and total — unknown names degrade to
 * readable fallbacks, never to raw codes in the UI.
 */

import type { ActionModel } from "./config-model";

/**
 * Modifier keys and their display names used in chord labels.
 * Exported so action-catalog.ts can import without re-declaring.
 */
export const MOD_LABELS: Record<string, string> = {
  leftctrl: "Ctrl",
  rightctrl: "Ctrl",
  leftshift: "Shift",
  rightshift: "Shift",
  leftalt: "Alt",
  rightalt: "AltGr",
  leftmeta: "Super",
  rightmeta: "Super",
};

/** Human-readable label for a chord key sequence: ["leftctrl","c"] → "Ctrl + C" */
export function chordLabel(keys: string[]): string {
  return keys.map((k) => MOD_LABELS[k] ?? keyLabel(k)).join(" + ");
}

/**
 * Optional catalog lookup injected by action-catalog.ts at module init.
 * Allows actionLabel to return the catalog entry label (e.g. "Copy") for
 * known chords without creating a circular import.
 */
type CatalogLookup = (action: ActionModel) => { label: string } | null;
let _catalogLookup: CatalogLookup | null = null;

/**
 * Called once by action-catalog.ts immediately after it builds the CATALOG.
 * Must be called before any actionLabel(chord) is used in practice, but
 * actionLabel degrades gracefully if it was never called.
 */
export function registerCatalogLookup(fn: CatalogLookup): void {
  _catalogLookup = fn;
}

/** Mouse controls named as the user sees them on the device. */
const MOUSE_CONTROLS: Record<string, string> = {
  btn_left: "Left click",
  btn_right: "Right click",
  btn_middle: "Middle click",
  mouse4: "Back button",
  mouse5: "Forward button",
  btn_forward: "Forward button 2",
  btn_back: "Back button 2",
  btn_task: "Task button",
  wheelup: "Scroll up",
  wheeldown: "Scroll down",
  wheelleft: "Scroll left",
  wheelright: "Scroll right",
};

/** Keyboard keys whose display label differs from capitalized name. */
const KEY_LABELS: Record<string, string> = {
  esc: "Esc",
  capslock: "Caps Lock",
  leftctrl: "Ctrl",
  rightctrl: "Right Ctrl",
  leftshift: "Shift",
  rightshift: "Right Shift",
  leftalt: "Alt",
  rightalt: "AltGr",
  leftmeta: "Super",
  rightmeta: "Right Super",
  pageup: "Page Up",
  pagedown: "Page Down",
  kpenter: "Numpad Enter",
  kpasterisk: "Numpad *",
  kpslash: "Numpad /",
  kpplus: "Numpad +",
  kpminus: "Numpad -",
  kpdot: "Numpad .",
};

/**
 * Keys that read as actions, not characters: assigning one means "this
 * button does X", so the label is the action itself.
 */
const ACTION_KEYS: Record<string, string> = {
  back: "Back",
  forward: "Forward",
  mute: "Mute",
  volumeup: "Volume up",
  volumedown: "Volume down",
  playpause: "Play / Pause",
  nextsong: "Next track",
  previoussong: "Previous track",
  print: "Screenshot",
};

/** Display label for a key name used as a keystroke ("q" → "Q"). */
export function keyLabel(name: string): string {
  const special = KEY_LABELS[name];
  if (special) return special;
  if (/^kp\d$/.test(name)) return `Numpad ${name.slice(2)}`;
  if (name.length === 1) return name.toUpperCase();
  if (/^f\d{1,2}$/.test(name)) return name.toUpperCase();
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** What to call a physical control in headers and tags. */
export function keyDisplayName(name: string): string {
  const mouse = MOUSE_CONTROLS[name];
  if (mouse) return mouse;
  const rawCode = /^key:(\d+)$/.exec(name);
  if (rawCode) return `Extra button (${rawCode[1]})`;
  return `${keyLabel(name)} key`;
}

/** One plain sentence for what an action does. Null = unmapped. */
export function actionLabel(action: ActionModel | null): string {
  if (!action || action.kind === "passthrough") return "Normal job";
  switch (action.kind) {
    case "disabled":
      return "Does nothing";
    case "key": {
      const named = ACTION_KEYS[action.key] ?? MOUSE_CONTROLS[action.key];
      if (named) return named;
      return `Types ${keyLabel(action.key)}`;
    }
    case "taphold": {
      const tap = keyLabel(action.tap);
      if (action.hold.startsWith("layer:")) {
        return `${tap} when tapped, ${action.hold.slice(6)} layer while held`;
      }
      return `${tap} when tapped, ${keyLabel(action.hold)} when held`;
    }
    case "chord": {
      if (_catalogLookup) {
        const entry = _catalogLookup(action);
        if (entry) return entry.label;
      }
      return `Presses ${chordLabel(action.keys)}`;
    }
    case "layer_toggle":
      return `Switches the ${action.layer} layer on/off`;
  }
}

