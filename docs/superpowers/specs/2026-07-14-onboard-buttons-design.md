# Onboard Buttons, Side-View Art & Single-Key Search

**Date:** 2026-07-14
**Status:** Approved pending final review
**Follows:** the six-phase experience redesign (`2026-07-13-experience-redesign-design.md`, Implemented)

## Problem

Three user-reported gaps after the redesign:

1. **Invisible buttons (W1).** The user's G502 X PLUS runs in HID++ onboard mode; its Profile 1 maps top button, front trigger, and thumb (sniper) to byte-identical BTN_LEFT, and the rear trigger to Esc (verified 2026-07-12 via pre-phase event capture). No downstream software can distinguish these — the mouse's own memory must be rewritten (libratbag/ratbagd's job). libratbag 0.18's device file misses this variant (matches only usb:046d:c098; the user's IDs are wired c095 / receiver c547). Conduit's curated G502X layout consequently stops at G5 with the rest marked firmware-only.
2. **Top-view art hides side buttons (W2).** DeviceArt/MouseIllustration draw mice top-down; side/thumb buttons are approximated dots.
3. **Single keys are unsearchable (W3).** Typing "1" or "esc" in the assignment search yields a blank void (screenshot evidence 2026-07-14): no result row, no hint, and the press-to-set row hides during search. Assigning plain keys works only via press-to-set, which is undiscoverable.

## W1 — Onboard-profile awareness

### Layer 1: Detection — the "Button check" flow

- Entry: a quiet link near the device picture in the editor: "Some buttons missing?"
- Flow: panel asks the user to press each physical button once, any order, with a live tally. Conduit records pre-phase (code, count) pairs for the active device.
- Collision verdict: two distinct press events sharing a code within one session, or a pointer-class device emitting keyboard codes (e.g. Esc), flags a collision set. Verdict copy (plain): "N of this mouse's buttons share signals, so Conduit can't tell them apart. This is stored in the mouse itself." A "Show technical details" pane carries the raw code map.
- Detection works for ANY mouse; it never requires ratbagd.

### Layer 2: The fix — curated ratbagd-backed onboard rewrite

- Button "Fix this mouse's memory", shown only when the device is in the curated fixable set (initially: G502 X family — wired c095, receiver c547, plus the already-matched c098).
- Mechanics (mirrors Phase 5 setup patterns exactly):
  - `packaging/libratbag/` gains the patched device file(s) (stock G502X data with match extended to `usb:046d:c095;usb:046d:c547`).
  - ONE pkexec batch: install device files to `/etc/libratbag-custom`, install a systemd drop-in setting `LIBRATBAG_DATA_DIR`, `systemctl enable --now ratbagd` (system service; root scope is legitimate here), restart ratbagd.
  - Then (unprivileged) drive `ratbagctl` to rewrite onboard Profile 1: side buttons → Back/Forward; the colliding buttons (top, front trigger, thumb, rear trigger) → F13, F14, F15, F16.
  - A confirm step BEFORE any write lists the exact button→signal changes and notes: "This changes the mouse's own memory — other computers (and G HUB) will see these assignments too."
  - Typed errors throughout; raw ratbagctl output only in the details pane. pkexec dismissal → the Phase 5 "You closed the password prompt" path.
- Unknown-collision mice: verdict + "Conduit can't fix this mouse automatically yet." No generic writes, ever.
- Post-fix: the flow re-runs the button check automatically to confirm unique codes, then celebrates ("All N buttons are now distinct.").

### Layer 3: Exposure — the buttons become real

- Engine: `f13`–`f24` names added to `crates/conduit-core/src/keys.rs` (evdev codes 183–194).
- UI vocabulary: keyboard-layout/`keyDisplayName` labels; the curated G502X layout (mouse-layouts.ts) gains ALL buttons with human names ("Top button", "Front trigger", "Thumb button", "Rear trigger", "Side front", "Side back"), the F-code plumbing invisible to the user.
- MouseIllustration/DeviceArt markers for the six additional controls (positions per W2's side view).
- Product nicety: the Key Tester's collision knowledge — when two buttons share a code and the mouse is unfixed, the editor shows one marker with a badge "3 buttons send this — run Button check" rather than pretending there's one button.

## W2 — Side-view mouse art

- `DeviceArt` and `MouseIllustration` render mice in RIGHT-SIDE PROFILE when the curated layout declares side buttons; top view remains for side-buttonless mice.
- Side view shows: body profile with thumb rest, real raised side-button shapes at the actual cluster position (2-strip for G502X, 4×3 grid for G600), wheel + left/right foreshortened at the top edge so every control keeps a marker home.
- One shared set of path data with a keep-in-sync comment between the two files (established pattern); markers and always-on job labels sit on the drawn buttons.
- Home cards and the editor stay visually consistent (same shapes, two sizes).

## W3 — Single-key search + no dead ends

- `parseKeyInput(query)` in the action-catalog module: trimmed, lowercased query matching a known key name or alias appends a synthesized row "Types {label}" (subtitle "The {label} key") saving `{kind:"key", key}`. Vocabulary generated from the same key table the engine uses (single source; a build-time or checked-in generated list from keys.rs — implementation may choose, but UI and engine must not drift).
- F13–F24 included, with catalog labels so fixed onboard buttons search humanly.
- Empty-search state: "No matches" row + the press-to-set row rendered during ALL searches (it currently hides), so search is never a dead end.
- Combo search (`parseComboInput`) unchanged and takes precedence where both could match (no single-key row for queries containing "+").

## Constraints inherited from the redesign

- All jargon bans hold (ratbagd/HID++/evdev names live only in technical-details panes); typed errors via `presentError`; verbatim-copy discipline for new user-facing strings once set in the plan; vitest cap 2, tsc clean, warnings-clean; no live system mutation in automated tests — ratbagctl/pkexec paths are pure-builder tested with coordinator-gated live verification (user confirmation required before any onboard write to the real mouse).

## Out of scope

- Full onboard-profile manager (multi-profile editing, DPI, RGB) — approach B, future.
- Generic (non-curated) onboard writes.
- Left-side/ambidextrous profile art variants.

## Success criteria

- After the guided fix, every physical G502X button appears in the editor with a distinct, assignable identity; button check confirms zero collisions.
- Mice with side buttons render in side view with markers on real button shapes.
- Typing "1" or "esc" in search offers "Types 1"/"Types Esc"; no search state renders an empty void.
