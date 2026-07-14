# Experience Redesign Phase 6: Polish Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. ALL implementer/fixer dispatches carry the anti-delegation contract. Ledger line numbers have drifted — implementers grep for current anchors; every deletion requires a zero-reference grep first.

**Goal:** Close out the redesign per spec Section 7's polish pass plus every deferred ledger item: the approved mockup palette with motion, the dead-code sweep, the a11y pass, a dozen triaged behavior nits, the two per-app leftovers (browser-first suggestions, picker advanced-match), and the engine's stuck-modifier-on-disconnect fix.

**Architecture:** Token-value swap (and `--teal`→`--accent` rename) brings the app to the approved mockup palette without touching component structure; motion arrives as two transition tokens plus a `prefers-reduced-motion` guard. Deletions are grep-gated. The engine gains device attribution on held entries and a `release_device` path wired to `DeviceRemoved`. Everything else is small, test-pinned behavior fixes enumerated from the ledger.

**Tech Stack:** CSS custom properties, React + TypeScript (vitest, fireEvent), Rust (conduit-core engine, Tauri setup.rs).

## Global Constraints

- `export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig` before cargo; vitest worker cap 2; `npx tsc --noEmit` clean; zero new `cargo build` warnings; fix-round verification includes tsc.
- Every task ends with ALL gates green: `cargo test --workspace`, `cargo test --manifest-path ui/src-tauri/Cargo.toml --lib`, `cd ui && npx vitest run && npx tsc --noEmit`.
- Deletion protocol: before removing any symbol/CSS class, `grep -rn "<name>" ui/src crates --include="*.rs" --include="*.ts" --include="*.tsx" --include="*.css"` must show only the definition (or the report explains each remaining hit). Quote the grep in the report.
- Palette (approved mockups, exact values): `--bg-body:#0d0f12; --bg-rail:#14171c; --bg-key:#1a1e25; --border-structural:#232830; --border-control:#2e3742; --text-hi:#e8ebef; --text-mid:#9aa3ad; --text-lo:#7d8794; --text-dim:#5f6873; --accent:#38bdf8; --accent-bg:rgba(56,189,248,.12); --accent-border:rgba(56,189,248,.45); --ok:#34d399;` — amber/red keep current values. Radii: `--r4:6px; --r6:10px;` New motion tokens: `--t-fast:120ms ease; --t-med:200ms ease;`
- Token rename is mechanical and TOTAL: `--teal`→`--accent`, `--teal-bg`→`--accent-bg`, `--teal-border`→`--accent-border` across ALL files (CSS + TSX `var(...)` uses in DeviceArt.tsx, MouseIllustration.tsx, anywhere else grep finds). Zero `--teal` references may remain.
- Jargon and copy rules from all prior phases remain binding for any touched string.
- Behavior-preserving unless a task explicitly lists the behavior change with a pinning test.

---

### Task 1: Palette, motion, and the inline-style sweep

**Files:**
- Modify: `ui/src/App.css` (`:root` block + rename sweep + motion), `ui/src/components/DeviceArt.tsx`, `ui/src/components/MouseIllustration.tsx` (var renames), `ui/src/screens/Status.tsx`, `ui/src/screens/Devices.tsx`, `ui/src/screens/KeyTester.tsx`, `ui/src/components/InspectorPanel.tsx`, `ui/src/components/ProfileMatchEditor.tsx` (inline `style={{…}}` → classes)

**Interfaces:** none new. Deliverables:
1. `:root` gets the Global-Constraints palette/radii/motion values; every `--teal*` reference renamed to `--accent*` (grep-verified zero remaining).
2. Motion: `transition: border-color var(--t-fast), background var(--t-fast), color var(--t-fast);` on interactive surfaces (`.device-card`, `.app-pill`, `.assign-cat`, `.cat-row`, `.help__tab`, `.setup__step`, `.btn`, `.toast` transform on entry), plus:
```css
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0s !important; animation-duration: 0s !important; }
}
```
3. Inline-style sweep: every `style={{…}}` in the five listed TSX files moves to a semantic class in App.css (name by role, e.g. `.status__mono-value`). `grep -rn "style={{" ui/src` afterwards may show only dynamic values that genuinely depend on runtime data (report each remaining hit with its reason).

- [ ] **Step 1:** Apply the `:root` swap + rename sweep; run UI suite (several tests assert `var(--teal)` NOWHERE — but DeviceArt.test may not; MouseIllustration/DeviceArt render with the token string in attributes: update any test asserting the literal token name, listing each in the commit body).
- [ ] **Step 2:** Add motion rules + reduced-motion guard.
- [ ] **Step 3:** Inline-style sweep with the grep proof.
- [ ] **Step 4:** All gates green. Commit: `style(ui): approved mockup palette, motion tokens, inline-style sweep`

---

### Task 2: Dead-code sweep

**Files:** `ui/src/App.css`, `ui/src/lib/action-labels.ts` (+ its test), `ui/src/App.tsx`, `ui/src/components/AppPicker.tsx` (if `.modal__footer` class remnants), others grep reveals.

**Deliverables (each item = grep-gate, delete, note in report):**
1. CSS blocks with zero TSX users: `.titlebar__daemon*`, `.rail__nav*`, `.btn--warn`, `.status-bar*`, `.modal__footer`, `.assign__quick*`, `.assign__pick*`, `.assign__or`, `.assign__advanced`, `.assign__capture*` (verify `--live` variant too), `.illo__wheel-ridge` (if still present), any `.setup-check__*` stragglers.
2. `QUICK_PICKS` + `QuickPick` in action-labels.ts and their test block (nothing imports them since Phase 3).
3. Stale comment `App.tsx` ~"Config model for profile rail" → reword to current reality; redundant `isDeviceView &&` guard in App.tsx (keep the type-narrowing `view.kind === "device"` check only).
4. Add `.assign__list` a real rule (it is USED but unstyled — ledger item): `display:flex; flex-direction:column; gap:2px; overflow-y:auto;`

- [ ] **Step 1:** Grep-gate + delete each item; **Step 2:** gates green (deleting QUICK_PICKS turns its test red first — delete test with it); **Step 3:** Commit: `chore(ui): dead-code sweep — orphaned CSS, QUICK_PICKS, stale comments`

---

### Task 3: A11y pass

**Files:** `ui/src/screens/Help.tsx` (+test), `ui/src/components/DeviceArt.tsx` (+test), `ui/src/screens/Home.tsx`, `ui/src/components/AppContextStrip.tsx` (+test), `ui/src/components/AppPillsBar.tsx`

**Deliverables:**
1. Help tabs: full tab pattern — each tab gets `id="help-tab-{id}"` + `aria-controls="help-panel-{id}"`; the body wraps in `<div role="tabpanel" id="help-panel-{id}" aria-labelledby="help-tab-{id}">`; ArrowLeft/ArrowRight move focus+selection between tabs (roving tabindex: selected tab `tabIndex=0`, others `-1`). Test: render, focus first tab, `fireEvent.keyDown(tab, { key: "ArrowRight" })`, assert second tab selected and focused.
2. DeviceArt: `aria-hidden="true"` on the svg, `role`/`aria-label` removed (the archetype slug was polluting card accessible names). Update DeviceArt.test.tsx (query by hidden + container.querySelector("svg")) and any Home test using `getByRole("img")`. Home card buttons then carry clean names — add an assertion that a card's accessible name equals exactly its device name + state text (no "gaming-mouse").
3. AppContextStrip: menu button `aria-label="More options"`; Escape closes the menu; click outside closes (document listener, cleaned up). Tests for both dismissals.
4. AppPillsBar: the pills container gets `role="tablist"` with pills as `role="tab"`/`aria-selected` (they behave as tabs); paused badge gets `aria-label="Switch automatically is off"`.

- [ ] Steps: failing tests → implement → gates green → Commit: `feat(ui): a11y pass — tab semantics, hidden decorative art, menu dismissal`

---

### Task 4: Behavior-nit bundle (UI)

**Files:** `ui/src/components/KeyboardViz.tsx`, `ui/src/components/Toast.tsx`, `ui/src/screens/Mappings.tsx`, `ui/src/screens/Setup.tsx`, `ui/src/screens/Status.tsx`, `ui/src/screens/Home.tsx`, `ui/src/lib/device-registry.ts`, `ui/src/components/InspectorPanel.tsx`, `ui/src/components/AppPicker.tsx` (+ tests for each behavior change)

**Deliverables (each with a pinning test; existing tests updated only where the old behavior was pinned):**
1. KeyboardViz chord hint: `keys.join("+").slice(0,6)` → `chordLabel(keys)` truncated to 6 chars ("Ctrl +" beats "leftct"). Test: chord `leftctrl+c` keycap hint renders "Ctrl +".
2. Toast auto-dismiss timer must not reset on parent re-render: effect keys on a stable toast identity (add `id: number` to ToastData, callers increment a ref counter; effect deps `[toast.id, toast.kind]`). Test: rerender with same toast object identity-but-new-parent-render at 3s, advance to 6.5s, dismissed exactly once.
3. `appPills` memoized in Mappings (`useMemo` on `[model, installedApps]`), used by all four consumers.
4. `handleUseDefault` no-ops (no mapping exists anywhere): skip applyWithUndo entirely and show no toast. Test: click hatch on unmapped key → setConfig NOT called.
5. Setup: `copyConfirm` resets when status changes; polling stops when `daemon_connected && variant==="firstrun" && allDone` or recovery success (clearInterval via a state-driven effect). Test with fake timers: after ALL_GREEN status, advancing 15s adds no setupStatus calls.
6. Recovery hero flash: while `status === null` render a minimal centered spinner (class `setup__loading`), never the first-run hero. Test: recovery variant, unresolved setupStatus promise → no "Let's get Conduit running" in DOM.
7. Status.tsx "Daemon unreachable — {raw}" → `presentError` title only ("Conduit's engine isn't running"); raw string dropped (Help's engine tab sits above SetupScreen which owns recovery). Test: no raw error text renders.
8. Setup relogin: when `relogin_needed` was returned, BOTH permission steps show the relogin note and their Allow buttons are suppressed (no second password prompt while pending). Test pins it.
9. Investment line: `appProfileCount` gains a per-device variant `appCountForDevice(model, phys)` = non-default profiles with ≥1 base key OR a device section matching this phys; Home uses it. Registry test.
10. `rememberedDevices` archetype heuristic: uncurated selector whose name part contains "keyboard" (case-insensitive) → archetype "keyboard". Test.
11. AppPicker window rows: display (and pass to onPick) the matched installed app's name when `matchInstalledApp(win.class, installed)` hits, else the class. Test: open-now row for class "steam" with Steam installed shows "Steam" and onPick receives ("Steam","steam").
12. InspectorPanel: Apply disabled (`disabled` attr) when `kind === "chord"`. Test.

- [ ] Steps: failing tests per item (one describe block "phase 6 nits") → implement → gates → Commit: `fix(ui): phase 6 behavior nits — toast timing, polling stop, inherited no-ops, labels`

---

### Task 5: Per-app leftovers — browser-first suggestions + picker advanced match

**Files:** `ui/src/components/AssignPanel.tsx` (+test), `ui/src/screens/Mappings.tsx`, `ui/src/components/AppPicker.tsx` (+test), `ui/src/components/AppContextStrip.tsx`

**Deliverables:**
1. `appContext` prop gains `isBrowser: boolean` (from the active pill). In AssignPanel, when `appContext?.isBrowser`, `popularEntries()` is reordered: entries whose `keywords` include "browser" first (stable order otherwise). Test: browser context puts "Back"/"Forward" before "Copy"; non-browser context unchanged.
2. Picker advanced match (spec §4 debt): restore a quiet link "Advanced: match a specific window…" in AppPicker that swaps the list for an inline mini-form: fields Class / Process / Title pattern (same semantics as ProfileMatchEditor), a name field pre-filled "Custom rule", Create button → `onPickAdvanced(name, match: Record<string,string>)` (new prop; Mappings handler: `addProfile` + `setProfileMatch` + applyWithUndo description `${name} added` + select it). Cancel returns to the list. Tests: link swaps to form; Create passes the cleaned match record; empty fields stripped.
3. Advanced-pill prose: AppContextStrip copy for `kind === "advanced"` pills replaces the raw label inside the sentence with "your custom rule" (title stays the pill label elsewhere). Test: strip for a title-matcher pill renders "When your custom rule matches the window you're using…" — adjust the sentence to: `When your custom rule matches, the highlighted buttons change. Everything else keeps its Everywhere setting.`

- [ ] Steps: failing tests → implement → gates → Commit: `feat(ui): browser-first suggestions and picker advanced match rule`

---

### Task 6: Rust bundle — stuck-modifier release on disconnect + username charset

**Files:** `crates/conduit-core/src/engine.rs` (+tests), `crates/conduit-daemon/src/runloop.rs` (+test if the fixture supports it), `ui/src-tauri/src/setup.rs` (+tests)

**Deliverables:**
1. Engine device attribution: `held` entries record their source slot. Change `held: HashMap<Key, HeldEntry>` value to `struct Held { entry: HeldEntry, source: Option<u16> }` (or add the field into HeldEntry variants' tuple — pick the smaller diff; `process(ev, slot)` already receives the slot). New method:
```rust
/// Emit releases for every output held by `source` and forget them.
/// Chords release in reverse order. Called when a device disappears
/// mid-hold so modifiers can't stick.
pub fn release_device(&mut self, source: u16) -> &[Event] {
    self.out.clear();
    let keys: Vec<Key> = self.held.iter()
        .filter(|(_, h)| h.source == Some(source))
        .map(|(k, _)| *k).collect();
    for k in keys {
        if let Some(h) = self.held.remove(&k) {
            match h.entry {
                HeldEntry::OutKey(out) =>
                    self.out.push(Event { key: out, state: KeyState::Release, time_us: 0 }),
                HeldEntry::OutChord(ch) =>
                    for ck in ch.keys().iter().rev() {
                        self.out.push(Event { key: *ck, state: KeyState::Release, time_us: 0 });
                    },
                HeldEntry::LayerHeld(l) => { /* pop layer, mirroring the release arm */ }
                HeldEntry::Swallowed => {}
            }
        }
    }
    &self.out
}
```
(LayerHeld: reuse the exact layer-pop logic from the Release arm.) Engine tests: press remapped key on slot 3 → `release_device(3)` emits the release and a later physical release emits nothing (entry gone); chord variant reverse-order; other slots untouched.
2. Runloop: `Msg::DeviceRemoved(path)` handler additionally resolves the removed device's slot (the `sources`/`slots` maps already associate paths↔slots — grep the DeviceRemoved arm) and runs `engine.release_device(slot)` through the normal emit path BEFORE recomputing slots. If the fixture can inject DeviceRemoved, add an integration test; if not, engine tests carry it (say which in the report).
3. setup.rs username charset: accept `[A-Za-z_][A-Za-z0-9_.-]*` (uppercase + dot legal on many distros); injection tests still reject shell metacharacters; new accept-test for "John.Doe".

- [ ] Steps: failing tests → implement → full workspace gates → Commit: `fix(core): release held outputs when their device disconnects; relax username charset`

---

### Task 7: Phase verification + closeout (coordinator)

- [ ] Full gates (workspace + tauri lib + vitest + tsc).
- [ ] Visual smoke of the palette: render the built UI (dev server or component render) and eyeball home/editor/setup for palette regressions (coordinator judgment; screenshot if available).
- [ ] Ledger closeout: mark the redesign's six phases complete; record the two intentionally-open items — keyboard shortcuts (deliberately not reintroduced; revisit with real usage) and the click-freeze incident repro (still awaiting user go-ahead; unrelated to this branch).
- [ ] Update `docs/superpowers/specs/2026-07-13-experience-redesign-design.md` status line to "Implemented (Phases 1–6)".

## Out of scope

- The click-freeze incident investigation (separate debugging thread with its own protocol).
- Daemon binary bundling/packaging for distribution; uninstall flow; polkit policy file.
- Icon lazy-fetch/48px-first optimization (recorded ledger item — do it here ONLY if Task 4's polling work makes it trivial; otherwise it stays on the v1.x list with the PATH-trust doc note).
