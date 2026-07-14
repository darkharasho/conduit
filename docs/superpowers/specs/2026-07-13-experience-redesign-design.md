# Conduit Experience Redesign

**Date:** 2026-07-13
**Status:** Implemented (Phases 1–6)
**Mockups:** `2026-07-13-experience-home-mockup.html`, `2026-07-13-experience-editor-mockup.html`, `2026-07-13-experience-perapp-mockup.html`, `2026-07-13-experience-setup-mockup.html`

## Problem

Conduit currently reads as "a janky layer over a technical and complicated daemon instead of a polished user experience" (user, 2026-07-13). A code survey confirmed the cause is structural, not cosmetic: the UI exposes the daemon's data model directly. Raw socket errors, TOML syntax, VID:PID selectors, `layer:` string prefixes, a Suspend/Resume daemon toggle, `cargo build` commands on first run, and an information architecture (Mappings / Key Tester / Devices / Status) that mirrors daemon anatomy rather than user intent.

The UX north star is Logitech G Hub (see project memory `conduit-usability-north-star`): plain language, click-the-picture assignment, per-app behavior, progressive disclosure of depth.

## Decisions made during brainstorming

1. **Scope:** the full journey — first-run → remap → per-app → daily driver — designed as one experience, implemented in phases.
2. **Stack freedom:** full stack. Daemon, proto, and Tauri shell all change where the experience requires it.
3. **Power features:** progressive disclosure. The default path is G Hub-simple; layers, tap-hold, macros, regex matching, and the TOML view live behind explicit "Advanced" entry points. No separate expert mode.
4. **Approach:** experience-first re-architecture (not in-place retrofit, not clean-slate rewrite). The IA is rebuilt around the journey; existing visualization/assignment components (MouseViz, CuratedLayout, AssignPanel, press-to-detect) are reused inside the new shell.

## Section 1 — Mental model & information architecture

The app's story: **"Your devices, and what their buttons do."**

New screen inventory:

1. **Devices (home)** — the app opens here. One card per connected device: illustration, friendly product name (never hex IDs), one-word state ("Working"), and an investment summary ("13 buttons · custom in 3 apps"). (The word "profile" never appears in the UI — see Section 4; the mockups predate this wording fix and still show "app profiles.") Click a card → device editor. Absorbs today's Devices table; grab semantics become a per-device "Control this device" toggle in plain words.
2. **Device editor** — evolved from Mappings: device picture with live callouts, click-to-assign, app-context bar on top. The heart of the app.
3. **Help & troubleshooting** — absorbs Status and Key Tester, reframed as diagnosis ("Is Conduit seeing your key presses?"). Not top-level navigation; visited when something is wrong.

Removed as UI concepts:

- **Suspend/Resume** → a small "Pause Conduit" control in the titlebar. Paused state shows a persistent amber banner. Pausing never touches config.
- **Daemon dot / the word "daemon"** → gone. Healthy engine = silence. Broken engine = the full recovery screen (Section 5), never a status detail.
- **Live TOML footer** → behind Advanced → "Show configuration", off by default.
- **OFFLINE device tabs** → "Remembered devices" section on home: dimmed card, "Its settings are saved and will come back when you plug it in."

Navigation collapses from four peer screens to **home → device → (rarely) help**.

## Section 2 — Home screen

See home mockup. Commitments:

- Cards, not a table. Illustration + real product name from the curated registry (Section 6) + green-dot "Working" state.
- "Working" is the only healthy state and it is quiet. If the engine is down, this screen is *replaced* by recovery — device cards never claim health that isn't real.
- Meta line shows the user's investment (buttons remapped, apps with custom behavior), not hardware specs.
- Remembered (disconnected) devices render dashed/dimmed with a plain-language sentence.
- Empty state: "Plug in a mouse or keyboard to get started" with an illustration. Never a blank grid or error.
- Device illustrations come from a curated registry: hand-drawn SVG archetypes (gaming mouse, productivity mouse, MMO mouse, 60%/TKL/full keyboard) plus exact-model art where curated (G502 X, G600 exist today). No device ever renders as a gray box.

## Section 3 — Assignment flow (device editor)

See editor mockup. Commitments:

- **The map is the overview.** Callouts around the device picture show every button's current job before any click.
- **Two selection modes:** click the picture, or physically press the button (press-to-detect, promoted to a first-class hint under the picture).
- **Search-first panel.** "Search anything" accepts action names, key combos, plain descriptions. Default view is a **Popular** list; categories (Shortcuts / Keys / Media & volume / System) are progressive disclosure. The plain remap path stays at two clicks: pick button → pick action. (Inverse of the G Hub anti-pattern: simple remaps must never be buried in category trees.)
- **No Apply button anywhere.** Selection applies instantly and optimistically. A toast confirms in plain words with **Undo** inline. On daemon rejection the same toast slot shows "That didn't stick — Try again" and the callout reverts. This one pattern replaces all Apply/Save/Saving ceremony.
- **Plain escape hatches:** "Use the button's normal behavior" and "Do nothing when pressed" (replacing unbind/noop).
- **Advanced entry:** one quiet link — "Advanced: different action on hold, macros…" — housing tap-hold, layers, macros, and the TOML view.

## Section 4 — Per-app behavior

See per-app mockup. The word "profile" is retired from the UI. Commitments:

- **Overlay model:** "Everywhere" is the base truth. An app pill is a sheet of exceptions: "When Firefox is the window you're using, the highlighted buttons change. Everything else keeps its Everywhere setting."
- **Visible inheritance:** overridden buttons glow in the app's color with their app-specific job; all others dim to "Same as Everywhere." The full delta is visible at a glance, per device.
- **Non-destructive toggle:** "Switch automatically" turns auto-switching off without losing settings (the G Hub pattern; never delete-to-stop). Deleting an app's settings is a separate explicit action behind the ⋯ menu with confirmation.
- **App picker, never regex:** "+ In an app…" lists running and installed apps with real icons (desktop entries + Wayland app_id via the KWin D-Bus focus backend). One click to add. The class/process/title regex editor moves behind "Advanced: match a specific window…" inside the picker.
- **App-aware suggestions:** with an app context active, the Popular list leads with curated actions for that app category (browser → Back/Forward/Reload/Close tab/Reopen tab).
- **Consequential escape hatch:** "Use the Everywhere setting (Copy)" shows what the button will inherit before you click.
- **Under the hood** the daemon keeps profiles and matchers. The UI compiles app picks into simple class matchers; existing regex profiles surface through the advanced path. Per-app switching on Wayland remains Conduit's differentiator.

## Section 5 — First-run & recovery

See setup mockup. Commitments:

- **Setup is performed by the app** via a polkit-backed helper (Section 6): installs the systemd user service, copies the udev rule, handles input-group membership. User's job: one password prompt.
- **Steps are consequences, not checks:** "Background service installed" (daemon), "Allowing Conduit to press keys for you" (uinput), "Access to your mice and keyboards" (input group). Live status while working; plain instruction when the user is genuinely needed (log out/in for group change), and the app resumes at the right step after relogin.
- **"Show technical details"** is the jargon quarantine: real commands, paths, and raw errors available verbatim behind one link — never the default face.
- **Recovery reuses this screen.** Engine dies later → the app swaps to this layout with the failing step highlighted: "Conduit's engine stopped — [Start it again]". If restart fails: "Copy report for a bug" bundling the technical details. Socket error strings never appear above the fold.
- **Missing config is not an error:** absent `conduit.toml` → a valid empty config is created; user lands on the device grid at defaults.

## Section 6 — The UX contract (daemon & IPC changes)

- **Typed errors.** The proto gains an error envelope: stable code (`engine-not-running`, `permission-denied`, `device-missing`, `config-invalid`, `apply-failed`, …) + structured params + original message demoted to `detail`. The UI holds one mapping table: code → plain sentence + recovery action. `detail` appears only inside "Show technical details." Unmapped errors render a generic "Something went wrong — Try again / Copy report," never a raw string.
- **Device identity.** Daemon reports VID:PID, class, and capabilities (declared codes exist today); the UI resolves against the curated registry → name + artwork, falling back to archetype art + generic names ("USB Mouse"). Unknown buttons get stable friendly labels ("Extra button 1"); `key:N` never renders.
- **Versioned, optimistic apply.** `setConfig` returns a version token; the daemon confirms or rejects by version event. UI applies optimistically and auto-reverts on rejection, feeding the error toast. **Undo** is an in-memory stack of recent config snapshots — undo re-applies the previous snapshot. Eliminates all silent `.catch(() => {})` paths: every apply resolves visibly.
- **Privileged setup helper.** Polkit-authorized operations, strictly limited to: install/enable service, install udev rule, group membership, restart engine.
- **Focus events carry app identity** (Wayland app_id + desktop entry) so app pills get names and icons for free.
- **Curated action catalog.** One vocabulary source (id, label, subtitle, category, per-app suggestions) that the UI picks from and compiles to the daemon's existing key syntax. The TOML format does not change; hand-edited configs keep working and the advanced TOML view stays truthful.

## Section 7 — Migration & testing

Six phases, each leaving the app shippable:

1. UX contract in proto/daemon + UI error-mapping table.
2. New shell and home screen.
3. Device editor + assignment panel (reusing MouseViz, CuratedLayout, AssignPanel, press-to-detect).
4. Per-app overlay.
5. Setup helper + first-run/recovery.
6. Polish pass: design tokens replacing the ~31 inline styles, motion, empty states.

No config migration: TOML remains the source of truth; regex profiles surface through the advanced matcher path.

Testing: vitest component tests for assignment/undo/error-mapping flows; Rust unit tests for the error envelope and versioned apply; existing suites migrate with their components.

## Out of scope

- Onboard-memory (ratbagd) profile management UI beyond what exists (the G502 X onboard rewrite fix is tracked separately).
- Macro recording UI (the Advanced entry point reserves space for it; design later).
- Light theme / theming system beyond the token pass.
