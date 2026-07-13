# Experience Redesign Phase 3: Device Editor & Assignment Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make assignment feel like the spec's Section 3: a chord-output primitive in the engine (so "Copy" can exist at all), a curated action catalog behind a search-first panel, instant apply with a real Undo toast, plain-language escape hatches, and the TOML echo demoted behind an Advanced disclosure.

**Architecture:** The core engine gains `Action::Chord` (2–4 keys, fixed-size `Copy` struct; press emits downs in order, release emits ups in reverse, mirroring the existing tap-hold multi-event precedent). The UI's `ActionModel` gains a matching `chord` kind whose raw TOML form is `"leftctrl+c"`. A new `action-catalog.ts` is the single vocabulary source (id/label/subtitle/category/popular/keywords → ActionModel) that AssignPanel renders search-first. A new `Toast` component plus an `applyWithUndo` path in Mappings delivers optimistic apply, an undo stack of config snapshots, and `presentError`-worded failure toasts with retry.

**Tech Stack:** Rust (conduit-core engine/config), React + TypeScript (vitest + @testing-library/react, `fireEvent` — userEvent is not a dependency).

## Global Constraints

- Before any `cargo` command: `export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig`.
- Vitest worker cap 2 (config-enforced); run `npx vitest run` from `ui/`; `npx tsc --noEmit` must stay clean.
- Chords: minimum 2, maximum 4 keys (`MAX_CHORD_KEYS = 4`). TOML grammar: a plain action string containing `+` is a chord, split on `+`; tokens parse through the existing `keys::from_name` (aliases like `ctrl` work). No key name contains `+`, so the separator is unambiguous.
- The catalog writes canonical raw strings using canonical key names (`leftctrl+c`, never `ctrl+c`) so serialized TOML round-trips through one spelling.
- Jargon ban holds for all new rendered copy: no "daemon", "socket", raw hex, `key:N`.
- Spec copy verbatim: footer hatches "Use the button's normal behavior" and "Do nothing when pressed"; search placeholder `Search anything — "screenshot", "ctrl+z", "mute"…`; category chips "Popular", "Shortcuts", "Keys", "Media & volume", "System". Advanced link copy is "Advanced: tap & hold, layers… ›" (deviation from the mockup's "macros…", which the engine does not have — do not promise macros).
- Error toast wording comes from `presentError` (Phase 1); apply-failure toast title must be its `title`, never a raw error string.
- Tap-hold `hold` fields do NOT accept chords in this phase (single key or layer only, unchanged).
- Every task ends green: `cargo test -p conduit-core -p conduit-daemon` and `cd ui && npx vitest run && npx tsc --noEmit`.

---

### Task 1: Core — chord parsing and compilation

**Files:**
- Modify: `crates/conduit-core/src/config.rs` (Action enum :14–21, ConfigError :91–110, `compile_raw_action` :488–525, tests at end)

**Interfaces:**
- Produces (Task 2 and daemon rely on): `pub const MAX_CHORD_KEYS: usize = 4;`, `pub struct Chord { … }` (`Copy`) with `pub fn new(keys: &[Key]) -> Option<Chord>` (None unless 2..=4 keys) and `pub fn keys(&self) -> &[Key]`; `Action::Chord(Chord)`; `ConfigError::BadChord { profile: String, chord: String }` with message `chord `{chord}` in profile `{profile}` must have 2 to 4 keys`.

- [ ] **Step 1: Write the failing tests** (append to config.rs tests)

```rust
    #[test]
    fn chord_string_compiles_to_chord_action() {
        let cfg = compile("[profile.default.keys]\nmouse4 = \"ctrl+c\"\n").unwrap();
        let a = cfg.profiles[0].lookup_base(keys::from_name("mouse4").unwrap());
        match a {
            Some(Action::Chord(ch)) => {
                let ks = ch.keys();
                assert_eq!(ks.len(), 2);
                assert_eq!(ks[0], keys::from_name("leftctrl").unwrap()); // alias resolved
                assert_eq!(ks[1], keys::from_name("c").unwrap());
            }
            other => panic!("expected Chord, got {other:?}"),
        }
    }

    #[test]
    fn chord_rejects_bad_shapes() {
        // 5 keys: too long
        let e = compile("[profile.default.keys]\na = \"ctrl+shift+alt+meta+c\"\n").unwrap_err();
        assert!(matches!(e, ConfigError::BadChord { .. }), "got {e:?}");
        // unknown token inside a chord
        let e = compile("[profile.default.keys]\na = \"ctrl+notakey\"\n").unwrap_err();
        assert!(matches!(e, ConfigError::UnknownKey { .. }), "got {e:?}");
        // trailing separator produces one real token → not a valid chord
        let e = compile("[profile.default.keys]\na = \"c+\"\n").unwrap_err();
        assert!(matches!(e, ConfigError::BadChord { .. }), "got {e:?}");
    }
```

(If profile lookup helpers differ from `lookup_base(key)`, use whatever accessor the existing compile tests at config.rs:590–760 use to reach a compiled base-layer action — keep assertions identical.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p conduit-core chord`
Expected: compile error — no `Chord`/`BadChord`.

- [ ] **Step 3: Implement**

Add near the Action enum:

```rust
pub const MAX_CHORD_KEYS: usize = 4;

/// A fixed-capacity multi-key output (e.g. Ctrl+C). Kept `Copy` so `Action`
/// stays `Copy` for the engine's lookup tables.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Chord {
    keys: [Key; MAX_CHORD_KEYS],
    len: u8,
}

impl Chord {
    pub fn new(keys: &[Key]) -> Option<Chord> {
        if keys.len() < 2 || keys.len() > MAX_CHORD_KEYS {
            return None;
        }
        let mut arr = [Key(0); MAX_CHORD_KEYS];
        arr[..keys.len()].copy_from_slice(keys);
        Some(Chord { keys: arr, len: keys.len() as u8 })
    }

    pub fn keys(&self) -> &[Key] {
        &self.keys[..self.len as usize]
    }
}
```

Add `Chord(Chord),` to `Action`. Add to `ConfigError`:

```rust
    #[error("chord `{chord}` in profile `{profile}` must have 2 to 4 keys")]
    BadChord { profile: String, chord: String },
```

In `compile_raw_action`'s `RawAction::Str(s)` match, insert BEFORE the final plain-key arm:

```rust
            s if s.contains('+') => {
                let toks: Vec<&str> =
                    s.split('+').filter(|t| !t.is_empty()).collect();
                let mut parsed = Vec::with_capacity(toks.len());
                for t in &toks {
                    parsed.push(parse_key_checked(t, ctx)?);
                }
                Chord::new(&parsed)
                    .map(Action::Chord)
                    .ok_or_else(|| ConfigError::BadChord {
                        profile: ctx.to_string(),
                        chord: s.clone(),
                    })
            }
```

`Action` is matched exhaustively in `engine.rs:process()`, so the crate will not compile until an arm exists.

- [ ] **Step 4: Add the temporary engine arm so this task stands alone and green**

Add a swallow-only Press arm in `engine.rs` with a comment stating Task 2 replaces it (Task 2's tests pin the real semantics, so this stub cannot silently survive):

```rust
            // Chord emission lands in the next commit; until then a chord
            // behaves as Disabled so the crate compiles. Replaced by the
            // full press/release implementation immediately after.
            Action::Chord(_) => {
                self.held.insert(ev.key, HeldEntry::Swallowed);
            }
```

Run: `cargo test -p conduit-core` — all green (new chord compile tests + existing suite).

- [ ] **Step 5: Commit**

```bash
git add crates/conduit-core/src/config.rs crates/conduit-core/src/engine.rs
git commit -m "feat(core): chord action parsing — 'ctrl+c' compiles to Action::Chord"
```

---

### Task 2: Core — engine emits chords

**Files:**
- Modify: `crates/conduit-core/src/engine.rs` (HeldEntry near :26, Press arm placeholder from Task 1, Release :223–235, Repeat :236–240, `do_suspend` :244–265, tests)

**Interfaces:**
- Consumes: `Action::Chord(Chord)`, `Chord::keys()` from Task 1.
- Produces: chord semantics the daemon inherits with zero daemon changes — Press: emit press of each chord key in declaration order (all with the physical event's `time_us`); store `HeldEntry::OutChord(Chord)`. Release: emit release of each key in REVERSE order. Repeat: forward the repeat to the LAST key only (the non-modifier). `do_suspend`: release held chords in reverse order at `time_us: 0`. Config-swap mid-hold: release follows the stored chord (existing `held`-map guarantee).

- [ ] **Step 1: Write the failing tests** (append to engine.rs tests)

```rust
    #[test]
    fn chord_press_emits_in_order_release_in_reverse() {
        let mut e = engine("[profile.default.keys]\nmouse4 = \"ctrl+c\"\n");
        assert_eq!(
            e.handle(press("mouse4", 5)),
            &[press("leftctrl", 5), press("c", 5)]
        );
        assert_eq!(
            e.handle(release("mouse4", 9)),
            &[release("c", 9), release("leftctrl", 9)]
        );
    }

    #[test]
    fn chord_repeat_repeats_only_last_key() {
        let mut e = engine("[profile.default.keys]\nmouse4 = \"ctrl+c\"\n");
        e.handle(press("mouse4", 0));
        let rep = Event { key: key("mouse4"), state: KeyState::Repeat, time_us: 3 };
        assert_eq!(
            e.handle(rep),
            &[Event { key: key("c"), state: KeyState::Repeat, time_us: 3 }]
        );
    }

    #[test]
    fn suspend_releases_chord_in_reverse() {
        let mut e = engine("[profile.default.keys]\nmouse4 = \"ctrl+shift+t\"\n");
        e.handle(press("mouse4", 0));
        let out = e.suspend().to_vec();
        let t = out.iter().position(|x| *x == release("t", 0)).unwrap();
        let s = out.iter().position(|x| *x == release("leftshift", 0)).unwrap();
        let c = out.iter().position(|x| *x == release("leftctrl", 0)).unwrap();
        assert!(t < s && s < c, "reverse order expected, got {out:?}");
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p conduit-core chord_`
Expected: FAIL — placeholder swallows the press.

- [ ] **Step 3: Implement**

`HeldEntry` gains `OutChord(Chord)` (import `Chord` from config). Replace the Task 1 placeholder Press arm:

```rust
            Action::Chord(ch) => {
                self.held.insert(ev.key, HeldEntry::OutChord(ch));
                for k in ch.keys() {
                    self.out.push(Event { key: *k, state: KeyState::Press, time_us: ev.time_us });
                }
            }
```

Release match gains:

```rust
            Some(HeldEntry::OutChord(ch)) => {
                for k in ch.keys().iter().rev() {
                    self.out.push(Event { key: *k, state: KeyState::Release, time_us: ev.time_us });
                }
            }
```

Repeat match gains (before the `Some(_) => {}` catch-all):

```rust
            Some(HeldEntry::OutChord(ch)) => {
                let last = *ch.keys().last().expect("chord len >= 2");
                self.out.push(Event { key: last, ..ev });
            }
```

`do_suspend`'s held-release loop gains a chord arm mirroring release-in-reverse at `time_us: 0`:

```rust
            if let HeldEntry::OutChord(ch) = entry {
                for k in ch.keys().iter().rev() {
                    self.out.push(Event { key: *k, state: KeyState::Release, time_us: 0 });
                }
            }
```

(Keep the existing `OutKey` arm; match both.)

- [ ] **Step 4: Full core + daemon suites**

Run: `cargo test -p conduit-core -p conduit-daemon`
Expected: PASS (daemon needs no changes; its runloop emits whatever slice the engine returns, one SYN per event — same as tap-hold flush today).

- [ ] **Step 5: Commit**

```bash
git add crates/conduit-core/src/engine.rs
git commit -m "feat(core): engine emits chord actions — ordered press, reverse release"
```

---

### Task 3: UI config-model — chord ActionModel

**Files:**
- Modify: `ui/src/lib/config-model.ts` (ActionModel :19–24, `rawToAction`/`actionToRaw` :66–107, `actionToTomlLine` :716–752)
- Test: `ui/src/lib/config-model.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 4–6 rely on): `ActionModel` gains `| { kind: "chord"; keys: string[] }`. Raw form: the joined string `keys.join("+")`. `rawToAction`: a plain string containing `+` parses to `{ kind: "chord", keys: s.split("+").filter(Boolean) }`. `actionToRaw` inverse. `actionToTomlLine` renders chords through the same string path (`mouse4 = "leftctrl+c"`).

- [ ] **Step 1: Write the failing tests**

```typescript
describe("chord actions", () => {
  it("round-trips a chord through TOML", () => {
    const m = parseConfigToml('[profile.default.keys]\nmouse4 = "leftctrl+c"');
    const a = getAction(m, "default", "base", "mouse4");
    expect(a).toEqual({ kind: "chord", keys: ["leftctrl", "c"] });
    expect(serializeConfigToml(m)).toContain('mouse4 = "leftctrl+c"');
  });

  it("setAction writes a chord and actionToTomlLine echoes it", () => {
    const m = parseConfigToml("[profile.default.keys]\n");
    const updated = setAction(m, "default", "base", "mouse5", {
      kind: "chord",
      keys: ["leftctrl", "leftshift", "t"],
    });
    expect(getAction(updated, "default", "base", "mouse5")).toEqual({
      kind: "chord",
      keys: ["leftctrl", "leftshift", "t"],
    });
    expect(
      actionToTomlLine("default", "base", "mouse5", {
        kind: "chord",
        keys: ["leftctrl", "leftshift", "t"],
      }),
    ).toContain('mouse5 = "leftctrl+leftshift+t"');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/lib/config-model.test.ts`
Expected: FAIL — chord strings currently parse as `{ kind: "key", key: "leftctrl+c" }`.

- [ ] **Step 3: Implement**

In `rawToAction`, in the string branch, BEFORE the plain-key fallback (and after the `layer:`/`disabled`/`passthrough` checks):

```typescript
  if (raw.includes("+")) {
    const keys = raw.split("+").filter((t) => t.length > 0);
    if (keys.length >= 2) return { kind: "chord", keys };
  }
```

In `actionToRaw`:

```typescript
  if (action.kind === "chord") return action.keys.join("+");
```

`actionToTomlLine` needs no chord-specific code if it delegates to `actionToRaw` for string actions — verify and, if it has its own switch, add the chord case producing the quoted joined string.

- [ ] **Step 4: Run tests + typecheck** (the added union member will surface exhaustiveness errors in `actionHint` (KeyboardViz.tsx:22–44) and `actionLabel` (action-labels.ts:86–106) if those switch exhaustively — add minimal arms now: KeyboardViz `actionHint` renders the joined keys' first 6 chars (`keys.join("+").slice(0, 6)`); `actionLabel` gets a temporary arm returning the joined "+" string, replaced properly in Task 4.)

Run: `cd ui && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/config-model.ts ui/src/lib/config-model.test.ts ui/src/lib/action-labels.ts ui/src/components/KeyboardViz.tsx
git commit -m "feat(ui): chord variant in the action model with TOML round-trip"
```

---

### Task 4: Action catalog — the vocabulary source

**Files:**
- Create: `ui/src/lib/action-catalog.ts`
- Modify: `ui/src/lib/action-labels.ts` (`actionLabel` chord arm)
- Test: `ui/src/lib/action-catalog.test.ts` (create), `ui/src/lib/action-labels.test.ts` (append)

**Interfaces:**
- Consumes: `ActionModel` (with chord) from Task 3.
- Produces (Tasks 5–6 rely on):

```typescript
export type CatalogCategory = "shortcuts" | "keys" | "media" | "system";
export interface CatalogEntry {
  id: string;
  label: string;        // "Copy"
  subtitle: string;     // "Ctrl + C"
  category: CatalogCategory;
  popular?: boolean;
  keywords?: string[];
  action: ActionModel;
}
export const CATALOG: CatalogEntry[];
export function searchCatalog(query: string): CatalogEntry[];   // "" → [] (callers show category lists)
export function popularEntries(): CatalogEntry[];
export function entriesFor(category: CatalogCategory): CatalogEntry[];
export function entryForAction(action: ActionModel): CatalogEntry | null;  // exact match by raw form
export function chordLabel(keys: string[]): string;             // ["leftctrl","c"] → "Ctrl + C"
export function parseComboInput(query: string): ActionModel | null; // "ctrl+z" → chord with canonical names, null if any token unknown
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";
import {
  CATALOG, chordLabel, entryForAction, entriesFor,
  parseComboInput, popularEntries, searchCatalog,
} from "./action-catalog";

describe("action catalog", () => {
  it("has copy/paste/undo as popular chord entries with canonical keys", () => {
    const copy = CATALOG.find((e) => e.id === "copy")!;
    expect(copy.action).toEqual({ kind: "chord", keys: ["leftctrl", "c"] });
    expect(copy.subtitle).toBe("Ctrl + C");
    expect(popularEntries().map((e) => e.id)).toContain("copy");
  });

  it("searches by label, subtitle, and keywords", () => {
    expect(searchCatalog("screenshot").map((e) => e.id)).toContain("screenshot");
    expect(searchCatalog("browser").map((e) => e.id)).toEqual(
      expect.arrayContaining(["back", "forward"]),
    );
    expect(searchCatalog("")).toEqual([]);
  });

  it("parses typed combos with alias canonicalization", () => {
    expect(parseComboInput("ctrl+z")).toEqual({ kind: "chord", keys: ["leftctrl", "z"] });
    expect(parseComboInput("ctrl+notakey")).toBeNull();
    expect(parseComboInput("plainword")).toBeNull();
  });

  it("labels chords humanly and reverse-looks-up catalog entries", () => {
    expect(chordLabel(["leftctrl", "leftshift", "t"])).toBe("Ctrl + Shift + T");
    expect(entryForAction({ kind: "chord", keys: ["leftctrl", "c"] })?.id).toBe("copy");
    expect(entryForAction({ kind: "key", key: "mute" })?.id).toBe("mute");
  });

  it("every category is non-empty and every entry has label+subtitle", () => {
    for (const cat of ["shortcuts", "keys", "media", "system"] as const) {
      expect(entriesFor(cat).length).toBeGreaterThan(0);
    }
    for (const e of CATALOG) {
      expect(e.label.length, e.id).toBeGreaterThan(0);
      expect(e.subtitle.length, e.id).toBeGreaterThan(0);
    }
  });
});
```

action-labels.test.ts addition:

```typescript
it("labels chord actions via the catalog, falling back to key math", () => {
  expect(actionLabel({ kind: "chord", keys: ["leftctrl", "c"] })).toBe("Copy");
  expect(actionLabel({ kind: "chord", keys: ["leftalt", "f4"] })).toBe("Presses Alt + F4");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/lib/action-catalog.test.ts src/lib/action-labels.test.ts`
Expected: FAIL — module missing / temporary chord arm returns joined string.

- [ ] **Step 3: Implement `action-catalog.ts`**

```typescript
import type { ActionModel } from "./config-model";
import { keyLabel } from "./action-labels";

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

const MOD_LABELS: Record<string, string> = {
  leftctrl: "Ctrl", rightctrl: "Ctrl", leftshift: "Shift", rightshift: "Shift",
  leftalt: "Alt", rightalt: "AltGr", leftmeta: "Super", rightmeta: "Super",
};

export function chordLabel(keys: string[]): string {
  return keys.map((k) => MOD_LABELS[k] ?? keyLabel(k)).join(" + ");
}

const chord = (...keys: string[]): ActionModel => ({ kind: "chord", keys });
const single = (key: string): ActionModel => ({ kind: "key", key });

export const CATALOG: CatalogEntry[] = [
  // Shortcuts (chords)
  { id: "copy", label: "Copy", subtitle: "Ctrl + C", category: "shortcuts", popular: true, action: chord("leftctrl", "c") },
  { id: "paste", label: "Paste", subtitle: "Ctrl + V", category: "shortcuts", popular: true, action: chord("leftctrl", "v") },
  { id: "cut", label: "Cut", subtitle: "Ctrl + X", category: "shortcuts", action: chord("leftctrl", "x") },
  { id: "undo", label: "Undo", subtitle: "Ctrl + Z", category: "shortcuts", popular: true, action: chord("leftctrl", "z") },
  { id: "redo", label: "Redo", subtitle: "Ctrl + Shift + Z", category: "shortcuts", action: chord("leftctrl", "leftshift", "z") },
  { id: "select-all", label: "Select all", subtitle: "Ctrl + A", category: "shortcuts", action: chord("leftctrl", "a") },
  { id: "find", label: "Find", subtitle: "Ctrl + F", category: "shortcuts", action: chord("leftctrl", "f") },
  { id: "save", label: "Save", subtitle: "Ctrl + S", category: "shortcuts", action: chord("leftctrl", "s") },
  { id: "new-tab", label: "New tab", subtitle: "Ctrl + T", category: "shortcuts", keywords: ["browser"], action: chord("leftctrl", "t") },
  { id: "close-tab", label: "Close tab", subtitle: "Ctrl + W", category: "shortcuts", keywords: ["browser"], action: chord("leftctrl", "w") },
  { id: "reopen-tab", label: "Reopen closed tab", subtitle: "Ctrl + Shift + T", category: "shortcuts", keywords: ["browser"], action: chord("leftctrl", "leftshift", "t") },
  { id: "switch-window", label: "Switch window", subtitle: "Alt + Tab", category: "shortcuts", action: chord("leftalt", "tab") },
  // Keys (single-key jobs)
  { id: "back", label: "Back", subtitle: "Browser / files", category: "keys", popular: true, keywords: ["browser", "navigate"], action: single("back") },
  { id: "forward", label: "Forward", subtitle: "Browser / files", category: "keys", keywords: ["browser", "navigate"], action: single("forward") },
  { id: "middle-click", label: "Middle click", subtitle: "Paste on Linux / open in tab", category: "keys", action: single("btn_middle") },
  { id: "escape", label: "Escape", subtitle: "Esc key", category: "keys", action: single("esc") },
  { id: "enter", label: "Enter", subtitle: "Return key", category: "keys", action: single("enter") },
  // Media & volume
  { id: "play-pause", label: "Play / Pause", subtitle: "Media control", category: "media", popular: true, keywords: ["music"], action: single("playpause") },
  { id: "next-track", label: "Next track", subtitle: "Media control", category: "media", keywords: ["music", "song"], action: single("nextsong") },
  { id: "previous-track", label: "Previous track", subtitle: "Media control", category: "media", keywords: ["music", "song"], action: single("previoussong") },
  { id: "mute", label: "Mute", subtitle: "System volume", category: "media", popular: true, action: single("mute") },
  { id: "volume-up", label: "Volume up", subtitle: "System volume", category: "media", action: single("volumeup") },
  { id: "volume-down", label: "Volume down", subtitle: "System volume", category: "media", action: single("volumedown") },
  // System
  { id: "screenshot", label: "Take a screenshot", subtitle: "Print Screen", category: "system", popular: true, keywords: ["capture", "screen"], action: single("print") },
  { id: "lock-screen", label: "Lock the screen", subtitle: "Super + L", category: "system", keywords: ["lock"], action: chord("leftmeta", "l") },
];

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
  return CATALOG.filter((e) =>
    e.label.toLowerCase().includes(q) ||
    e.subtitle.toLowerCase().includes(q) ||
    (e.keywords ?? []).some((k) => k.includes(q)),
  );
}

// Keys the UI will accept in a typed combo. The daemon remains the final
// validator (config-invalid → revert toast), this just filters nonsense.
const COMBO_TOKEN = /^[a-z0-9_]{1,12}$/;
const KNOWN_ALIASES: Record<string, string> = {
  ctrl: "leftctrl", alt: "leftalt", shift: "leftshift",
  meta: "leftmeta", super: "leftmeta",
};
const KNOWN_TOKENS = new Set([
  "leftctrl", "rightctrl", "leftshift", "rightshift", "leftalt", "rightalt",
  "leftmeta", "rightmeta", "tab", "esc", "enter", "space", "backspace",
  "delete", "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "print", ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
]);

export function parseComboInput(query: string): ActionModel | null {
  const parts = query.trim().toLowerCase().split("+").map((p) => p.trim());
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
```

action-labels.ts: replace the Task 3 temporary chord arm in `actionLabel`:

```typescript
  if (action.kind === "chord") {
    // Late import to avoid a cycle: catalog imports keyLabel from here.
    const { entryForAction, chordLabel } = require("./action-catalog") as typeof import("./action-catalog");
    const entry = entryForAction(action);
    return entry ? entry.label : `Presses ${chordLabel(action.keys)}`;
  }
```

If `require` is unavailable under the ESM build, invert the dependency instead: move the `MOD_LABELS` table and `chordLabel` implementation into action-labels.ts (exported), have action-catalog.ts import them AND re-export `chordLabel` (the catalog tests import it from `./action-catalog` — that import must keep working), and give action-labels.ts a `registerCatalogLookup(fn: (a: ActionModel) => CatalogEntryLike | null)` setter that action-catalog.ts calls at module init so `actionLabel` can consult the catalog without a cycle. State which resolution was used in the report.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd ui && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/action-catalog.ts ui/src/lib/action-catalog.test.ts ui/src/lib/action-labels.ts ui/src/lib/action-labels.test.ts
git commit -m "feat(ui): curated action catalog with chords, search, and combo parsing"
```

---

### Task 5: Toast + instant apply with undo

**Files:**
- Create: `ui/src/components/Toast.tsx`
- Modify: `ui/src/screens/Mappings.tsx` (`persist()` :156–165, `handleSaveAction` :167–182, render tail)
- Modify: `ui/src/App.css` (append)
- Test: `ui/src/components/Toast.test.tsx` (create), `ui/src/screens/Mappings.test.tsx` (append)

**Interfaces:**
- Consumes: `presentError`, `ConduitError` (Phase 1); existing `setConfig`/`serializeConfigToml`.
- Produces:

```tsx
// Toast.tsx
export interface ToastData {
  kind: "success" | "error";
  message: string;             // already-humanized (presentError output for errors)
  actionLabel?: string;        // "Undo" | "Try again"
  onAction?: () => void;
}
export function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }): JSX.Element;
// success auto-dismisses after 6s; error stays until dismissed or actioned.
```

Mappings: `persist` is replaced by `applyWithUndo(updated: ConfigModel, description: string)`:
1. snapshot `prev = model`; push `{ prev, description }` onto an undo stack (max 10, in a ref);
2. `setModel(updated)` (optimistic, unchanged behavior);
3. `await setConfig(serializeConfigToml(updated))`;
4. success → success toast `` `${description}` `` with `actionLabel: "Undo"`, whose `onAction` pops the stack and re-applies `prev` via the same path with description "Undone" and WITHOUT pushing a new undo frame;
5. failure → revert `setModel(prev)`, pop the frame, and error toast: `message = presentError(err).title`, `actionLabel: "Try again"`, `onAction` re-runs `applyWithUndo(updated, description)`.

`description` strings come from the caller: `` `${keyDisplayName(editingKey)} now does ${actionLabel(action)}` `` for saves; "Back to its normal behavior" for use-default; "Button disabled" for do-nothing.

- [ ] **Step 1: Write the failing tests**

Toast.test.tsx:

```tsx
import { act, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Toast } from "./Toast";

describe("Toast", () => {
  it("renders message and fires the action", () => {
    const onAction = vi.fn();
    const onDismiss = vi.fn();
    render(
      <Toast
        toast={{ kind: "success", message: "Side button now does Copy", actionLabel: "Undo", onAction }}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Side button now does Copy");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onAction).toHaveBeenCalled();
  });

  it("auto-dismisses success after 6s but keeps errors", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const { rerender } = render(
      <Toast toast={{ kind: "success", message: "ok" }} onDismiss={onDismiss} />,
    );
    act(() => vi.advanceTimersByTime(6100));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    rerender(<Toast toast={{ kind: "error", message: "That didn't stick" }} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(60000));
    expect(onDismiss).toHaveBeenCalledTimes(1); // errors never auto-dismiss
    vi.useRealTimers();
  });
});
```

Mappings.test.tsx additions (follow the file's existing mock/render helpers):

```tsx
it("apply failure reverts the model and offers Try again with plain language", async () => {
  // arrange: render with a mapped config, select a key, make setConfig reject once
  mockSetConfig.mockRejectedValueOnce(
    new ConduitError("config-invalid", "config rejected", "TOML parse error at line 3"),
  );
  // act: save an action via the panel (existing helper flow)
  // assert:
  expect(await screen.findByRole("status")).toHaveTextContent("That change couldn't be applied");
  expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  expect(screen.queryByText(/line 3|TOML/)).toBeNull();          // raw detail never renders
  expect(mockSetConfig).toHaveBeenCalledTimes(1);                 // optimistic model reverted, no retry yet
});

it("undo re-applies the previous config", async () => {
  // act: save an action successfully, click Undo on the toast
  // assert: setConfig called a second time with TOML lacking the new mapping
});
```

(Write these two tests fully against the real helpers in the file — the skeleton comments above name the required assertions; the implementer fills the arrange/act plumbing that the file's existing tests already demonstrate.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/components/Toast.test.tsx src/screens/Mappings.test.tsx`
Expected: FAIL — Toast missing; Mappings has no toast/undo.

- [ ] **Step 3: Implement** Toast.tsx:

```tsx
import { useEffect } from "react";

export interface ToastData {
  kind: "success" | "error";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  useEffect(() => {
    if (toast.kind !== "success") return;
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  return (
    <div className={`toast toast--${toast.kind}`} role="status">
      <span className="toast__msg">{toast.message}</span>
      {toast.actionLabel && toast.onAction && (
        <button className="toast__action" onClick={toast.onAction}>
          {toast.actionLabel}
        </button>
      )}
      <button className="toast__close" aria-label="Dismiss" onClick={onDismiss}>✕</button>
    </div>
  );
}
```

Mappings.tsx: implement `applyWithUndo` exactly per the Interfaces block (undo stack in `useRef<{ prev: ConfigModel; description: string }[]>([])`, `toast` state `ToastData | null`, render `<Toast>` at the end of the screen when set). Rewire `handleSaveAction`, the use-default path, and the disable path to call it with the description strings from the Interfaces block. Remove the old `persist()`.

CSS append:

```css
/* ── Toast ───────────────────────────────────────────────────────────── */
.toast { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 14px; padding: 10px 16px; border-radius: var(--r6); background: var(--bg-key); border: 1px solid var(--border-control); font-size: 13px; color: var(--text-hi); box-shadow: 0 8px 24px rgba(0,0,0,.4); z-index: 40; }
.toast--error { border-color: var(--amber-border); }
.toast__action { background: none; border: none; color: var(--teal); font: inherit; font-weight: 600; cursor: pointer; }
.toast__close { background: none; border: none; color: var(--text-dim); font: inherit; cursor: pointer; }
```

- [ ] **Step 4: Run the suite**

Run: `cd ui && npx vitest run && npx tsc --noEmit`
Expected: PASS (existing Mappings tests updated only where they asserted the removed `loadError`-on-save behavior; list changes in the commit body).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/Toast.tsx ui/src/components/Toast.test.tsx ui/src/screens/Mappings.tsx ui/src/screens/Mappings.test.tsx ui/src/App.css
git commit -m "feat(ui): instant apply with undo toast and plain-language failure retry"
```

---

### Task 6: AssignPanel — search-first assignment

**Files:**
- Modify: `ui/src/components/AssignPanel.tsx` (full rework of the list area; keep props contract)
- Test: `ui/src/components/AssignPanel.test.tsx` (rework)
- Modify: `ui/src/App.css` (append)

**Interfaces:**
- Consumes: `CATALOG` helpers from Task 4 (`searchCatalog`, `popularEntries`, `entriesFor`, `parseComboInput`, `chordLabel`), existing `captureNextKey`, `actionLabel`.
- Produces: same external props contract as today (`keyName, model, activeProfile, activeLayer, currentAction, tomlEcho, onSave, onUseDefault, onClose`) so Mappings needs no signature change. New internal layout, top to bottom:
  1. header: key chip + "Right now it does: {actionLabel(currentAction)}";
  2. search input, placeholder exactly `Search anything — "screenshot", "ctrl+z", "mute"…`;
  3. category chips: Popular (default), Shortcuts, Keys, Media & volume, System;
  4. entry list: label + subtitle rows from the active category or live search results; a typed combo that `parseComboInput` accepts appends a synthetic row `Press {chordLabel(keys)}` / subtitle "Custom shortcut";
  5. "Keys" category additionally has the press-to-set row (existing `captureNextKey` flow, copy: "Press a key to type it…");
  6. footer: "Use the button's normal behavior" (→ `onUseDefault`), "Do nothing when pressed" (→ `onSave({ kind: "disabled" })`), quiet link "Advanced: tap & hold, layers… ›" (toggles InspectorPanel exactly as today).
- QUICK_PICKS is no longer rendered by AssignPanel (the catalog supersedes it); leave the export in action-labels.ts untouched (other consumers/tests) and note it for Phase 6 cleanup.

- [ ] **Step 1: Rework the failing tests** (AssignPanel.test.tsx — keep the existing mock scaffolding for `captureNextKey`; replace quick-pick tests)

```tsx
it("shows Popular by default and saves a catalog entry on click", async () => {
  renderPanel(); // existing helper
  expect(screen.getByPlaceholderText(/Search anything/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledWith({ kind: "chord", keys: ["leftctrl", "c"] }),
  );
});

it("search finds actions and typed combos become a custom row", async () => {
  renderPanel();
  fireEvent.change(screen.getByPlaceholderText(/Search anything/), {
    target: { value: "ctrl+z" },
  });
  expect(screen.getByText("Undo")).toBeInTheDocument();            // catalog hit (subtitle Ctrl + Z)
  fireEvent.click(screen.getByRole("button", { name: /Press Ctrl \+ Z/ }));
  await waitFor(() =>
    expect(onSave).toHaveBeenCalledWith({ kind: "chord", keys: ["leftctrl", "z"] }),
  );
});

it("renders the plain-language escape hatches", () => {
  renderPanel();
  expect(screen.getByRole("button", { name: "Use the button's normal behavior" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Do nothing when pressed" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Advanced: tap & hold, layers/ })).toBeInTheDocument();
});

it("Keys category exposes press-to-set", async () => {
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Keys" }));
  expect(screen.getByRole("button", { name: /Press a key to type it/ })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/components/AssignPanel.test.tsx`
Expected: FAIL against the current quick-picks layout.

- [ ] **Step 3: Implement the rework** — internal state `query: string`, `category: "popular" | CatalogCategory`; list = `query ? [...searchCatalog(query), ...(parseComboInput(query) ? [syntheticRow] : [])] : (category === "popular" ? popularEntries() : entriesFor(category))`. Rows are buttons: `<div class="cat-row__label">{label}</div><div class="cat-row__sub">{subtitle}</div>`, onClick → `save(entry.action)` (existing busy/error plumbing). Footer buttons renamed per the Interfaces block; the advanced toggle keeps rendering InspectorPanel unchanged. Category chip classes: `assign-cat` / `assign-cat--sel`.

CSS append (tokens only):

```css
/* ── Search-first assignment panel ───────────────────────────────────── */
.assign-search { display: flex; align-items: center; gap: 8px; margin-top: 12px; padding: 8px 12px; background: var(--bg-body); border: 1px solid var(--border-control); border-radius: var(--r6); }
.assign-search input { flex: 1; background: none; border: none; outline: none; color: var(--text-hi); font: inherit; font-size: 13px; }
.assign-cats { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.assign-cat { font-size: 12px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border-control); background: none; color: var(--text-mid); cursor: pointer; font: inherit; }
.assign-cat--sel { background: var(--teal-bg); border-color: var(--teal-border); color: var(--text-hi); }
.cat-row { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; width: 100%; text-align: left; padding: 8px 10px; border: none; background: none; border-radius: var(--r4); cursor: pointer; font: inherit; }
.cat-row:hover { background: var(--bg-key); }
.cat-row__label { font-size: 13.5px; color: var(--text-hi); }
.cat-row__sub { font-size: 11.5px; color: var(--text-lo); }
.assign-adv-link { background: none; border: none; color: var(--text-dim); font: inherit; font-size: 12px; cursor: pointer; margin-top: 8px; text-align: left; padding: 4px 0; }
```

- [ ] **Step 4: Run the suite**

Run: `cd ui && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/AssignPanel.tsx ui/src/components/AssignPanel.test.tsx ui/src/App.css
git commit -m "feat(ui): search-first assignment panel backed by the action catalog"
```

---

### Task 7: Advanced disclosure + map-is-the-overview polish

**Files:**
- Modify: `ui/src/components/InspectorPanel.tsx` (TOML footer :306–311)
- Modify: `ui/src/components/MouseIllustration.tsx` (always-on labels)
- Modify: `ui/src/screens/Mappings.tsx` (press-to-detect hint copy)
- Test: `ui/src/components/MouseIllustration.test.tsx` (append), `ui/src/components/AssignPanel.test.tsx` (append one TOML-disclosure test — the inspector renders inside the panel)
- Modify: `ui/src/App.css` (append)

**Interfaces:**
- Consumes: everything already on the branch.
- Produces:
  - InspectorPanel: the TOML echo footer renders ONLY after clicking a quiet link "Show configuration" (default hidden; toggles to "Hide configuration"). No other InspectorPanel behavior changes.
  - MouseIllustration: each visible marker with a mapped action renders a small always-on text label next to it: `actionLabel(effective action)` truncated to 14 chars (`label.length > 14 ? label.slice(0, 13) + "…" : label`), class `illo__joblabel`, `pointer-events: none`. Unmapped markers render nothing extra. The selected-key callout behavior is unchanged.
  - Mappings: the Detect control's helper copy becomes: button label "Select by pressing" and hint text beside it "…then press the button on your device". (The auto-arm-always design is rejected: on keyboards every keystroke would steal selection.)

- [ ] **Step 1: Write the failing tests**

MouseIllustration.test.tsx addition (follow the file's existing render helper that passes a model):

```tsx
it("shows an always-on job label for mapped controls", () => {
  const model = parseConfigToml('[profile.default.keys]\nmouse4 = "leftctrl+c"');
  renderIllo({ model }); // existing helper with defaults
  expect(screen.getByText("Copy")).toBeInTheDocument();
});
```

AssignPanel.test.tsx addition:

```tsx
it("hides the TOML echo behind Show configuration", async () => {
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: /Advanced: tap & hold, layers/ }));
  expect(screen.queryByText(/conduit\.toml/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show configuration" }));
  expect(screen.getByText(/conduit\.toml/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/components/MouseIllustration.test.tsx src/components/AssignPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement** — InspectorPanel: `const [showToml, setShowToml] = useState(false);` wrap the footer:

```tsx
      <button
        className="assign-adv-link"
        onClick={() => setShowToml((v) => !v)}
      >
        {showToml ? "Hide configuration" : "Show configuration"}
      </button>
      {showToml && (
        <div className="inspector__toml">
          {liveToml ?? <span className="muted">fill fields above to preview</span>}
        </div>
      )}
```

MouseIllustration: inside the marker group loop, alongside each marker with a mapped effective action:

```tsx
        {action && (
          <text
            className="illo__joblabel"
            x={pos.x + 26}
            y={pos.y + 4}
          >
            {jobLabel}
          </text>
        )}
```

with `jobLabel` computed via `actionLabel(...)` + the 14-char truncation, and CSS:

```css
/* ── Always-on job labels on the mouse diagram ───────────────────────── */
.illo__joblabel { font-size: 11px; fill: var(--text-lo); pointer-events: none; }
```

Mappings: apply the copy change to the Detect button block (:315–320).

- [ ] **Step 4: Run everything**

Run: `cd ui && npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/InspectorPanel.tsx ui/src/components/MouseIllustration.tsx ui/src/screens/Mappings.tsx ui/src/components/MouseIllustration.test.tsx ui/src/components/AssignPanel.test.tsx ui/src/App.css
git commit -m "feat(ui): TOML behind Show configuration; always-on job labels on the map"
```

---

### Task 8: Phase verification

**Files:** none expected; fixes only.

- [ ] **Step 1: Full gates**

Run: `export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig && cargo test --workspace && cd ui && npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 2: Isolated-daemon chord round-trip** (no service is installed on this machine; use the isolated pattern)

```bash
cd /var/home/mstephens/Documents/GitHub/conduit
export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig
cargo build --release -p conduit-daemon
T=/tmp/conduit-smoke3; rm -rf $T && mkdir -p $T/conduit
printf '[devices]\n\n[profile.default.keys]\n' > $T/conduit/conduit.toml
(XDG_CONFIG_HOME=$T CONDUIT_SOCKET=$T/sock setsid nohup target/release/conduit-daemon > $T/daemon.log 2>&1 &)
sleep 1.5
printf '%s\n' '{"type":"set_config","toml":"[profile.default.keys]\nmouse4 = \"ctrl+c\"\n"}' | python3 -c "
import socket,sys,json
s=socket.socket(socket.AF_UNIX); s.connect('/tmp/conduit-smoke3/sock')
s.sendall(sys.stdin.buffer.read()); print(s.recv(65536).decode())"
```

Expected: `{"type":"config_applied","version":1}` — a chord config compiles and applies on the wire. Also send an invalid chord (`"a+b+c+d+e"`) and expect `{"type":"err","code":"config-invalid",...}` whose detail contains "must have 2 to 4 keys". Kill the daemon and `rm -rf /tmp/conduit-smoke3` afterwards.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "test: phase 3 verification fixes"
```

(Skip if nothing changed.)

## Out of scope (later phases)

- Macros / recorded sequences (no engine primitive; the Advanced link deliberately does not mention them).
- Chords in tap-hold `hold` fields.
- Per-app suggestion ranking in the catalog (`Phase 4` wires app context; the `keywords` field is the hook).
- KeyTester "phase" wording and remaining technical copy in Help screens (Phase 5/6).
- QUICK_PICKS removal from action-labels.ts (Phase 6 cleanup, after nothing imports it).
