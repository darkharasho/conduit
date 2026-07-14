/**
 * action-catalog.ts
 *
 * The curated vocabulary of assignable actions shown in the assignment panel.
 * Every entry is pre-labeled and categorized; Tasks 5–6 consume CATALOG,
 * searchCatalog, popularEntries, entriesFor, and entryForAction.
 *
 * Dependency note: this module imports keyLabel and chordLabel from
 * action-labels.ts, then calls registerCatalogLookup() so that actionLabel()
 * can return e.g. "Copy" for chord actions known to the catalog — without a
 * circular import. chordLabel is also re-exported here because catalog tests
 * import it from this file.
 */

import type { ActionModel } from "./config-model";
import { chordLabel, registerCatalogLookup } from "./action-labels";
import { KEY_NAME_SET } from "./key-names";

export type CatalogCategory = "shortcuts" | "keys" | "media" | "system";

export interface CatalogEntry {
  id: string;
  label: string;
  subtitle: string;
  category: CatalogCategory;
  popular?: boolean;
  keywords?: string[];
  action: ActionModel;
}

// Re-export for callers that import chordLabel from this module
export { chordLabel };

// ── Helpers ───────────────────────────────────────────────────────────────────

const chord = (...keys: string[]): ActionModel => ({ kind: "chord", keys });
const single = (key: string): ActionModel => ({ kind: "key", key });

// ── Catalog ───────────────────────────────────────────────────────────────────

export const CATALOG: CatalogEntry[] = [
  // Shortcuts (chords)
  {
    id: "copy",
    label: "Copy",
    subtitle: "Ctrl + C",
    category: "shortcuts",
    popular: true,
    action: chord("leftctrl", "c"),
  },
  {
    id: "paste",
    label: "Paste",
    subtitle: "Ctrl + V",
    category: "shortcuts",
    popular: true,
    action: chord("leftctrl", "v"),
  },
  {
    id: "cut",
    label: "Cut",
    subtitle: "Ctrl + X",
    category: "shortcuts",
    action: chord("leftctrl", "x"),
  },
  {
    id: "undo",
    label: "Undo",
    subtitle: "Ctrl + Z",
    category: "shortcuts",
    popular: true,
    action: chord("leftctrl", "z"),
  },
  {
    id: "redo",
    label: "Redo",
    subtitle: "Ctrl + Shift + Z",
    category: "shortcuts",
    action: chord("leftctrl", "leftshift", "z"),
  },
  {
    id: "select-all",
    label: "Select all",
    subtitle: "Ctrl + A",
    category: "shortcuts",
    action: chord("leftctrl", "a"),
  },
  {
    id: "find",
    label: "Find",
    subtitle: "Ctrl + F",
    category: "shortcuts",
    action: chord("leftctrl", "f"),
  },
  {
    id: "save",
    label: "Save",
    subtitle: "Ctrl + S",
    category: "shortcuts",
    action: chord("leftctrl", "s"),
  },
  {
    id: "new-tab",
    label: "New tab",
    subtitle: "Ctrl + T",
    category: "shortcuts",
    keywords: ["browser"],
    action: chord("leftctrl", "t"),
  },
  {
    id: "close-tab",
    label: "Close tab",
    subtitle: "Ctrl + W",
    category: "shortcuts",
    keywords: ["browser"],
    action: chord("leftctrl", "w"),
  },
  {
    id: "reopen-tab",
    label: "Reopen closed tab",
    subtitle: "Ctrl + Shift + T",
    category: "shortcuts",
    keywords: ["browser"],
    action: chord("leftctrl", "leftshift", "t"),
  },
  {
    id: "switch-window",
    label: "Switch window",
    subtitle: "Alt + Tab",
    category: "shortcuts",
    action: chord("leftalt", "tab"),
  },
  // Keys (single-key jobs)
  {
    id: "back",
    label: "Back",
    subtitle: "Browser / files",
    category: "keys",
    popular: true,
    keywords: ["browser", "navigate"],
    action: single("back"),
  },
  {
    id: "forward",
    label: "Forward",
    subtitle: "Browser / files",
    category: "keys",
    popular: true,
    keywords: ["browser", "navigate"],
    action: single("forward"),
  },
  {
    id: "middle-click",
    label: "Middle click",
    subtitle: "Paste on Linux / open in tab",
    category: "keys",
    action: single("btn_middle"),
  },
  {
    id: "escape",
    label: "Escape",
    subtitle: "Esc key",
    category: "keys",
    action: single("esc"),
  },
  {
    id: "enter",
    label: "Enter",
    subtitle: "Return key",
    category: "keys",
    action: single("enter"),
  },
  // Media & volume
  {
    id: "play-pause",
    label: "Play / Pause",
    subtitle: "Media control",
    category: "media",
    popular: true,
    keywords: ["music"],
    action: single("playpause"),
  },
  {
    id: "next-track",
    label: "Next track",
    subtitle: "Media control",
    category: "media",
    keywords: ["music", "song"],
    action: single("nextsong"),
  },
  {
    id: "previous-track",
    label: "Previous track",
    subtitle: "Media control",
    category: "media",
    keywords: ["music", "song"],
    action: single("previoussong"),
  },
  {
    id: "mute",
    label: "Mute",
    subtitle: "System volume",
    category: "media",
    popular: true,
    action: single("mute"),
  },
  {
    id: "volume-up",
    label: "Volume up",
    subtitle: "System volume",
    category: "media",
    action: single("volumeup"),
  },
  {
    id: "volume-down",
    label: "Volume down",
    subtitle: "System volume",
    category: "media",
    action: single("volumedown"),
  },
  // System
  {
    id: "screenshot",
    label: "Take a screenshot",
    subtitle: "Print Screen",
    category: "system",
    popular: true,
    keywords: ["capture", "screen"],
    action: single("print"),
  },
  {
    id: "lock-screen",
    label: "Lock the screen",
    subtitle: "Super + L",
    category: "system",
    keywords: ["lock"],
    action: chord("leftmeta", "l"),
  },
];

// ── Register catalog lookup in action-labels ──────────────────────────────────

// Called at module init so actionLabel() can return catalog names (e.g. "Copy")
// for chord actions rather than the "Presses Ctrl + C" fallback.
registerCatalogLookup((action: ActionModel) => entryForAction(action));

// ── Query functions ───────────────────────────────────────────────────────────

function rawOf(action: ActionModel): string | null {
  if (action.kind === "key") return action.key;
  if (action.kind === "chord") return action.keys.join("+");
  return null;
}

export function entryForAction(action: ActionModel): CatalogEntry | null {
  const raw = rawOf(action);
  if (raw === null) return null;
  return CATALOG.find((e) => rawOf(e.action) === raw) ?? null;
}

export function popularEntries(): CatalogEntry[] {
  return CATALOG.filter((e) => e.popular);
}

export function entriesFor(category: CatalogCategory): CatalogEntry[] {
  return CATALOG.filter((e) => e.category === category);
}

export function searchCatalog(query: string): CatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return CATALOG.filter(
    (e) =>
      e.label.toLowerCase().includes(q) ||
      e.subtitle.toLowerCase().includes(q) ||
      (e.keywords ?? []).some((k) => k.includes(q)),
  );
}

// ── Combo parser ──────────────────────────────────────────────────────────────

// Keys the UI will accept in a typed combo. The daemon remains the final
// validator (config-invalid → revert toast), this just filters nonsense.
const COMBO_TOKEN = /^[a-z0-9_]{1,12}$/;

const KNOWN_ALIASES: Record<string, string> = {
  ctrl: "leftctrl",
  alt: "leftalt",
  shift: "leftshift",
  meta: "leftmeta",
  super: "leftmeta",
  escape: "esc",
};

// KEY_NAME_SET is the superset of all canonical key names (sync'd with keys.rs).
// Using it here means combo vocabulary grows automatically as keys.rs grows.
const KNOWN_TOKENS = KEY_NAME_SET;

export function parseComboInput(query: string): ActionModel | null {
  const parts = query
    .trim()
    .toLowerCase()
    .split("+")
    .map((p) => p.trim());
  if (parts.length < 2 || parts.length > 4) return null;
  const keys: string[] = [];
  for (const p of parts) {
    if (!COMBO_TOKEN.test(p)) return null;
    const canonical = KNOWN_ALIASES[p] ?? p;
    if (!KNOWN_TOKENS.has(canonical)) return null;
    keys.push(canonical);
  }
  return { kind: "chord", keys };
}

/**
 * Parses a single-key query (no "+" allowed).
 * Trims and lowercases; resolves KNOWN_ALIASES; checks KEY_NAME_SET.
 * Returns {kind:"key", key: canonical} if valid, else null.
 */
export function parseKeyInput(query: string): ActionModel | null {
  const q = query.trim().toLowerCase();
  if (!q || q.includes("+")) return null;
  const canonical = KNOWN_ALIASES[q] ?? q;
  if (!KEY_NAME_SET.has(canonical)) return null;
  return { kind: "key", key: canonical };
}

