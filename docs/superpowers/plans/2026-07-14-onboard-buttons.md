# Onboard Buttons, Side-View Art & Single-Key Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. ALL implementer/fixer dispatches carry the anti-delegation contract; implementers grep for current line anchors.

**Goal:** Implement spec `2026-07-14-onboard-buttons-design.md`: the Button-check collision detector, the curated ratbagd-backed onboard fix for the G502 X family, full button exposure (F13–F24), side-view mouse art, and single-key search with no dead ends.

**Architecture:** W3 and the engine key names land first (small, independent). W1 splits detection (pure collision logic + a guided panel, no ratbagd) from the fix (a Tauri `ratbag.rs` module: pure builders for the patched device file/drop-in/pkexec batch, pure parsers for `ratbagctl` output, thin command wrappers; UI drives read→confirm→rewrite→re-check). W2 rides on the same curated-layout update the fix requires. The live onboard write happens ONLY in the coordinator's user-gated verification task.

**Tech Stack:** Rust (conduit-core keys, Tauri shell + ratbagctl subprocess), React + TypeScript (vitest, fireEvent), libratbag/ratbagd via `/etc/libratbag-custom` + `LIBRATBAG_DATA_DIR` drop-in (host is Bazzite: `/usr/share/libratbag` is immutable — never target it).

## Global Constraints

- All redesign-era constraints hold: PKG_CONFIG_PATH export before cargo; vitest cap 2; tsc clean; warnings-clean; typed errors via presentError; jargon bans — "ratbagd", "libratbag", "HID++", "macro", KEY_* names, and button indices render ONLY inside technical-details panes.
- No automated test executes `ratbagctl`, `pkexec`, or `systemctl`: subprocess paths are thin wrappers over pure, unit-tested builders/parsers.
- NO onboard write outside Task 8's coordinator flow, which requires explicit user confirmation in-conversation before `ratbagctl … action set …` touches the real mouse.
- Machine facts (verified 2026-07-14): user's mouse = "Logitech G502 X PLUS", evdev vendor:product 046d:4099, via LIGHTSPEED receiver USB id 046d:C547; wired X PLUS would be c095. Stock `/usr/share/libratbag/logitech-g502-x.device` matches only `usb:046d:c099`; there is also `logitech-g502-x-wireless.device` (content unread — Task 5 reads it and extends whichever variant is correct). `ratbagctl` verbs: `action set button B` / `action set special S` / `action set key S` / `action set macro +KEY_X -KEY_X`; `action get` reads (G600 sample: `Button: 6 is mapped to macro '↕KEY_F18'`).
- Collision-fix policy (deterministic, no physical-position guessing): read Profile 1 via ratbagctl; every button with index > 2 whose action duplicates `button 1|2|3`, plus any button mapped to a key/macro that another button also emits or that collides with a keyboard key the user relies on (the Esc trigger), is a rewrite target. Targets are rewritten IN INDEX ORDER to macros `KEY_F13`, `KEY_F14`, `KEY_F15`, `KEY_F16` (extend to F24 if more). Buttons already mapped to `button 4`/`button 5` (Back/Forward sides) are left untouched.
- Curated fixable set v1: G502 X family only (`usb:046d:c099`, `c095`, receiver `c547`).
- Key-vocabulary sync: `ui/src/lib/key-names.ts` (new, checked in) must not drift from `crates/conduit-core/src/keys.rs` — BOTH sides carry a count-pinning test with the same literal (currently the keys.rs table count + 12 new F-keys) and a keep-in-sync comment naming the other file.
- Every task ends with all gates green: `cargo test --workspace`, `cargo test --manifest-path ui/src-tauri/Cargo.toml --lib`, `cd ui && npx vitest run && npx tsc --noEmit`.

---

### Task 1: Engine + UI vocabulary — F13–F24 and key-names.ts

**Files:**
- Modify: `crates/conduit-core/src/keys.rs` (KEYS table; f12 currently `("f12", 88)`)
- Modify: `ui/src/lib/keyboard-layout.ts` (F-key label rows), `ui/src/lib/action-labels.ts` (keyDisplayName passthrough — verify F-keys already label via the uppercase rule)
- Create: `ui/src/lib/key-names.ts` + `ui/src/lib/key-names.test.ts`

**Interfaces:**
- Produces: keys.rs accepts `f13`…`f24` (evdev codes 183–194: `("f13",183), ("f14",184), ("f15",185), ("f16",186), ("f17",187), ("f18",188), ("f19",189), ("f20",190), ("f21",191), ("f22",192), ("f23",193), ("f24",194)`). `key-names.ts` exports `export const KEY_NAMES: readonly string[]` (every canonical name from keys.rs, hand-transcribed) and `export const KEY_NAME_SET: ReadonlySet<string>`; Task 2 consumes the set. Sync tests: keys.rs gains `#[test] fn key_table_count_pinned() { assert_eq!(KEYS.len(), <N>); }` and key-names.test.ts asserts `KEY_NAMES.length === <N>` with the same `<N>` (compute the real number during implementation) — both with comments naming the counterpart file.

- [ ] **Step 1:** Failing Rust test `from_name("f13") == Some(Key(183))` and `from_name("f24") == Some(Key(194))`; failing key-names test (module missing).
- [ ] **Step 2:** Implement: extend KEYS; add the count-pin tests both sides; keyboard-layout gains f13–f24 label entries `{ name: "f13", label: "F13", width: 1 }` (rendered only when a device declares them — verify KeyboardViz filters by declared keys, which it does).
- [ ] **Step 3:** All gates. Commit: `feat(core+ui): F13–F24 key names with cross-language vocabulary pinning`

---

### Task 2: W3 — single-key search, no dead ends

**Files:**
- Modify: `ui/src/lib/action-catalog.ts` (+ `.test.ts`), `ui/src/components/AssignPanel.tsx` (+ `.test.tsx`)

**Interfaces:**
- Consumes: `KEY_NAME_SET` from Task 1; existing `KNOWN_ALIASES`, `parseComboInput`, `keyLabel`.
- Produces: `export function parseKeyInput(query: string): ActionModel | null` — trimmed/lowercased query; returns `{kind:"key", key: canonical}` when `KNOWN_ALIASES[q] ?? q` ∈ KEY_NAME_SET AND the query contains no "+"; else null. AssignPanel behavior: (a) search results append the synthesized row label `Types {keyLabel(key)}` / subtitle `The {keyLabel(key)} key` when parseKeyInput hits (combo row still takes precedence for "+" queries — mutually exclusive by construction); (b) the press-to-set row renders during ALL searches (today it hides when `query` is non-empty); (c) zero-result searches render a `cat-row`-styled non-button row "No matches — press the key on your keyboard instead".

- [ ] **Step 1: Failing tests** (action-catalog): `parseKeyInput("esc")` → `{kind:"key",key:"esc"}`; `parseKeyInput("1")` → key "1"; `parseKeyInput("escape")` → "esc" (alias); `parseKeyInput("ctrl+c")` → null; `parseKeyInput("notakey")` → null; `parseKeyInput("f13")` → key "f13". (AssignPanel): searching "1" shows button "Types 1" and clicking saves `{kind:"key",key:"1"}`; searching "zzzz" shows "No matches — press the key on your keyboard instead" AND the press-to-set row is present; searching "esc" in APP CONTEXT still works (regression guard for the screenshot scenario).
- [ ] **Step 2:** Implement per the Interfaces block. KNOWN_TOKENS in parseComboInput switches to `KEY_NAME_SET` (superset — combo vocabulary grows for free; keep the 2–4 arity and COMBO_TOKEN gate; update the combo test only if the old set excluded something now valid).
- [ ] **Step 3:** All gates. Commit: `feat(ui): single-key search with no-dead-end assignment panel`

---

### Task 3: W1 detection — collision logic (pure)

**Files:**
- Create: `ui/src/lib/button-check.ts` + `ui/src/lib/button-check.test.ts`

**Interfaces:**
- Produces (Task 4 consumes):

```typescript
export interface PressSample { code: number; keyName: string; }
export interface CollisionReport {
  distinct: number;                     // distinct codes observed
  presses: number;                      // total presses recorded
  collisions: { code: number; keyName: string; count: number }[]; // codes hit by 2+ *separated* presses
  keyboardCodes: { code: number; keyName: string }[]; // keyboard-range codes from a pointer device (e.g. esc=1)
}
export function analyzePresses(samples: PressSample[], deviceClass: string): CollisionReport;
// A "separated press" heuristic: consecutive identical codes count once (held/repeat);
// the same code re-appearing AFTER a different code (or after itself with another code in
// between) increments its press count. collisions = codes with count >= 2.
// keyboardCodes: deviceClass is mouse/touchpad AND code < 0x100 (below BTN range).
```

- [ ] **Step 1: Failing tests:** samples `[left,left]` (double-click, consecutive) → no collision; `[left, side, left]` → left count 2 → collision (two physical buttons share left); `[esc]` on class "mouse" → keyboardCodes contains esc; `[side, extra]` → distinct 2, no collisions; empty → zeros.
- [ ] **Step 2:** Implement. **Step 3:** gates. Commit: `feat(ui): button-check collision analysis`

---

### Task 4: W1 detection — the Button check panel

**Files:**
- Create: `ui/src/components/ButtonCheck.tsx` + `.test.tsx`
- Modify: `ui/src/screens/Mappings.tsx` (entry link near the picture), `ui/src/App.css` (append)

**Interfaces:**
- Consumes: `analyzePresses`/`CollisionReport` (Task 3); `onKeyEvent` pre-phase stream filtered by active device name (same pattern as the detect flow in Mappings — reuse its device-name filter approach); the active `DeviceInfo`.
- Produces: `ButtonCheck({ device, onClose, onFix }: { device: DeviceInfo; onClose: () => void; onFix?: () => void })` — a panel (same visual family as AppPicker's modal): intro "Press each button on your {name} once — any order."; live tally "N signals seen · M presses"; a Done button producing the verdict:
  - no collisions → "All N buttons send distinct signals. You're all set."
  - collisions → EXACTLY: "{K} of this mouse's buttons share signals, so Conduit can't tell them apart. This is stored in the mouse itself." plus, when `onFix` is provided (curated device), button "Fix this mouse's memory" → `onFix()`; when not, "Conduit can't fix this mouse automatically yet."
  - "Show technical details" quarantine pane listing the raw code map (codes, names, counts).
- Mappings: quiet link "Some buttons missing?" (class `assign-adv-link`) near the viz opens the panel; passes `onFix` only when `device.vendor === 0x046d && [0x4099, 0xc099, 0xc095].includes(device.product)` (helper `isOnboardFixable(dev)` exported from button-check.ts for Task 6 reuse).

- [ ] **Step 1: Failing tests:** render, feed three pre-phase events via the mocked listener (two sharing a code), click Done → verdict copy verbatim + Fix button present when onFix given; non-curated device (onFix absent) → "can't fix … yet" copy; technical pane hidden until clicked (jargon quarantine test: "ratbagd", KEY names, code numbers absent pre-click).
- [ ] **Step 2:** Implement + Mappings link + CSS (reuse modal/`setup__step` patterns).
- [ ] **Step 3:** gates. Commit: `feat(ui): guided Button check with plain-language collision verdict`

---

### Task 5: W1 fix plumbing — Tauri `ratbag.rs`

**Files:**
- Create: `ui/src-tauri/src/ratbag.rs`, `packaging/libratbag/README.md` (one paragraph: why these files exist, Bazzite immutability, match extension)
- Modify: `ui/src-tauri/src/lib.rs` (register commands), `ui/src/lib/client.ts` (+ client.test.ts)

**Interfaces (pure, unit-tested):**

```rust
pub const DATA_DIR: &str = "/etc/libratbag-custom";
pub fn patched_device_file(stock: &str, extra_matches: &[&str]) -> String;
// Parses the INI-ish stock content, extends the DeviceMatch= line with ";"-joined extras
// (deduped), leaves everything else byte-identical. Panics never; malformed input returns
// stock unchanged with the match line appended if absent.
pub fn ratbagd_dropin() -> &'static str;
// "[Service]\nEnvironment=LIBRATBAG_DATA_DIR=/etc/libratbag-custom\n"
pub fn fix_setup_script() -> String;
// set -e batch for ONE pkexec: mkdir -p /etc/libratbag-custom;
// cp -r /usr/share/libratbag/. /etc/libratbag-custom/  (stock set — env override replaces the whole dir);
// (the patched .device file is written by the UNPRIVILEGED side first to a temp path and the
//  script cp's it in — script takes the temp path as its only interpolated value, validated
//  to match ^/tmp/conduit-ratbag-[A-Za-z0-9]+/[a-z0-9.-]+$);
// mkdir -p /etc/systemd/system/ratbagd.service.d; printf the drop-in;
// systemctl daemon-reload; systemctl enable --now ratbagd; systemctl restart ratbagd
pub struct OnboardButton { pub index: u8, pub action: String } // action verbatim from ratbagctl
pub fn parse_button_map(info_output: &str) -> Vec<OnboardButton>;
// Parses "  Button: 6 is mapped to 'button 1'" / "… macro '↕KEY_F18'" lines from `ratbagctl <dev> info`.
pub fn rewrite_targets(buttons: &[OnboardButton]) -> Vec<(u8, String)>;
// Applies the Global-Constraints collision-fix policy; returns (index, "KEY_F13"…) pairs in
// index order. 'button 4'/'button 5' untouched; indices 0..=2 never targeted.
```

Commands (thin): `ratbag_stage_device_file() -> Result<String /*temp path*/, ErrorPayload>` (reads `/usr/share/libratbag/logitech-g502-x.device` at runtime — falling back to an embedded copy of the stock content if unreadable — applies `patched_device_file` with the three match ids, writes to a fresh `/tmp/conduit-ratbag-<rand>/` dir, returns the path); `ratbag_status() -> Result<RatbagStatus, ErrorPayload>` where `RatbagStatus { daemon_running: bool, device_id: Option<String>, device_name: Option<String> }` (parse `ratbagctl list` for a G502 line); `ratbag_read_buttons(device_id) -> Result<Vec<OnboardButtonDto>, ErrorPayload>` (`ratbagctl <id> info` + parse_button_map; Dto adds a `human: String` — "Left click"/"Back"/"Types F18" rendering of the action for the confirm sheet, pure fn `humanize_action(&str) -> String` with tests); `ratbag_fix_setup(patched_device_temp_path)` (pkexec batch; 126/127 → permission-denied like Phase 5); `ratbag_rewrite(device_id, targets: Vec<(u8, String)>)` — sequential unprivileged `ratbagctl <id> profile 0 button <n> action set macro +<KEY> -<KEY>` calls, first failure aborts with stderr in detail. Client bindings for all four.

- [ ] **Step 1: Failing Rust tests:** patched_device_file extends `DeviceMatch=usb:046d:c099` → `usb:046d:c099;usb:046d:c095;usb:046d:c547` (dedupes repeats, preserves other lines byte-identical); fix_setup_script contains the cp/dropin/systemctl lines, single-prompt (never invokes pkexec itself), rejects a hostile temp path; parse_button_map parses the G600 sample lines (`'button 1'`, `macro '↕KEY_F18'`, `none`); rewrite_targets on a synthetic G502X map (`0→button1, 1→button2, 2→button3, 3→button4, 4→button5, 5→button1, 6→button1, 7→key Esc… format as ratbagctl renders`) returns `[(5,"KEY_F13"),(6,"KEY_F14"),(7,"KEY_F15")]`-style pairs (adjust to the exact policy incl. the Esc/keyboard-key case); humanize_action("button 1")=="Left click", ("macro '↕KEY_F18'")=="Types F18", ("none")=="Nothing".
- [ ] **Step 2:** Implement; register; client bindings + passthrough tests.
- [ ] **Step 3:** All gates (incl. warnings-clean). Commit: `feat(tauri): ratbag module — patched device data, one-prompt setup, read/rewrite plumbing`

---

### Task 6: W1 fix UI — read → confirm → rewrite → re-check

**Files:**
- Modify: `ui/src/components/ButtonCheck.tsx` (+ `.test.tsx`), `ui/src/App.css` (append)

**Interfaces:**
- Consumes: Task 5 client fns; `isOnboardFixable`.
- Produces: the `onFix` flow inside ButtonCheck (replacing the bare callback with an internal fix wizard):
  1. `ratbag_status()` — if the device is missing from ratbagd, show "Preparing the fix — you'll be asked for your password once." → `ratbag_stage_device_file()` (Task 5) → `ratbag_fix_setup(path)` → re-status (poll ≤10s).
  2. `ratbag_read_buttons` → confirm sheet: each rewrite target as "“{human-now}” → will send its own signal", verbatim footer: "This changes the mouse's own memory — other computers (and G HUB) will see these assignments too." Buttons: Cancel / "Rewrite {N} buttons".
  3. `ratbag_rewrite` → success → auto re-run the press-check phase ("Press the fixed buttons to confirm") → all-distinct verdict → "All N buttons are now distinct."
  - Every failure path: presentError title inline + raw stderr only in the details pane.

- [ ] **Step 1: Failing tests** (mock all four client fns): happy path walks status→read→confirm(assert the exact footer sentence + a target row rendering "Left click → will send its own signal")→rewrite called with the targets from the mocked read→success state; pkexec-dismissed rejection on fix_setup shows "You closed the password prompt" inline; rewrite failure mid-sequence shows error + details quarantine.
- [ ] **Step 2:** Implement. **Step 3:** gates. Commit: `feat(ui): onboard fix wizard — read, confirm, rewrite, verify`

---

### Task 7: W2 side-view art + full G502X layout

**Files:**
- Modify: `ui/src/components/DeviceArt.tsx` (+ test), `ui/src/components/MouseIllustration.tsx` (+ test), `ui/src/lib/mouse-layouts.ts` (+ any layout test), `ui/src/lib/device-registry.ts` (archetype plumb if needed), `ui/src/App.css`

**Interfaces:**
- `DeviceLayout` gains `sideButtons?: boolean` (set true for G502X and G600 entries). DeviceArt gains prop-independent internal branch: when rendering archetypes `gaming-mouse`/`mmo-mouse` AND the caller passes new optional prop `sideView?: boolean`, draw the right-profile body (new shared path set: profile body, thumb rest, 2-strip side buttons for gaming, 4×3 grid for mmo, foreshortened wheel + top-edge left/right). Home passes `sideView` from `layoutFor(...)?.sideButtons` (device-registry may need to expose the lookup — smallest seam: Home already has nodes; call `layoutFor` directly). MouseIllustration: same rule, same shared paths scaled (keep-in-sync comments both files), MARKER_POS gets a side-view variant table covering ALL G502X controls: btn_left, btn_right, btn_middle, mouse4, mouse5, f13 ("Top button"), f14 ("Front trigger"), f15 ("Thumb button"), f16 ("Rear trigger") — provisional physical labels per the deterministic index-order rewrite; Task 8 corrects labels if the live mapping lands differently.
- mouse-layouts.ts G502X entry: the four firmware-only `key: null` rows become real keyed buttons (`f13`–`f16`, labels above, note removed) plus a new note row explaining they need the one-time fix when unfixed: keep ONE null-key row variant? NO — keyed rows always; the editor already dims keys the device never emits (capability filter uses declared codes — after the onboard fix the F-codes appear in `DeviceInfo.keys` on reconnect; before the fix they render dimmed, which is honest). G9/profile-cycle stays null-key (truly not remappable).
- keyDisplayName: with the curated layout supplying labels, verify chips show "Top button" not "F13 key" (curated label wins — check CuratedLayout uses `b.label`; it does).

- [ ] **Step 1: Failing tests:** DeviceArt sideView renders a `side-mouse` group (query by data-attr `data-view="side"`); MouseIllustration with the G502X layout renders markers for f13–f16 (assert `[data-key="f13"]` exists) and job labels sit on them; layout test: G502X entry has zero null-key rows except profile-cycle.
- [ ] **Step 2:** Implement art + layout + CSS. **Step 3:** gates. Commit: `feat(ui): side-view mouse art and full G502X button exposure`

---

### Task 8: Coordinator live verification (USER-GATED)

- [ ] Full gates.
- [ ] Stage the fix on THIS machine via the real command path (ratbag_status → fix_setup): requires pkexec password from the user — **ask first**. Verify `ratbagctl list` now shows the G502 X PLUS.
- [ ] `ratbag_read_buttons` against the real mouse; show the user the exact rewrite plan (which onboard slots, from what, to what); **explicit confirmation required**.
- [ ] Rewrite; run the Button check live; confirm all buttons distinct; correct the provisional f13–f16 physical labels in mouse-layouts.ts/MARKER_POS if the observed order differs; commit any label fix.
- [ ] Update memories: `g502x-onboard-profile` (fix applied, new mappings) and the backlog memory (items done).

## Out of scope

- Approach B (full onboard manager), multi-profile/DPI/RGB, non-curated writes, left-hand art variants (all per spec).
- SPEC DEVIATION (deliberate, record in ledger): the spec's editor badge for unfixed collisions ("3 buttons send this — run Button check") needs persisted Button-check results; deferred to v1.x. The Button check itself is the discovery path meanwhile.
