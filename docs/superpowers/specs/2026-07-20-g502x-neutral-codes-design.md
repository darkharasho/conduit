# G502 X Full Neutral-Code Conversion — Design

**Date:** 2026-07-20
**Status:** Approved (scope A — G502 X only)

## Goal

Every custom keyboard binding in the G502 X PLUS onboard profile becomes a
neutral code (F13–F24), with conduit's default profile reproducing the
original behavior in software — so every button is a first-class, per-app
remappable identity in conduit. Generalizes the F15 side-button pattern from
`2026-07-20-runelite-shift-sidebutton-design.md`.

## Decision

Convert the two colliding bindings; leave the one already-neutral binding:

| Onboard button | Current | New | Rationale |
|---|---|---|---|
| b3 (rear trigger) | Esc (HID 41) | F13 (HID 104) | collides with Wooting Esc |
| b5 | Space (HID 44) | F14 (HID 105) | collides with Wooting Space |
| b8 | F18 (HID 109) | unchanged | already unique — no keyboard emits F18 |
| b4 (side button) | F15 | unchanged | done earlier today |

Out of scope: mouse buttons (left/right/middle), special-behavior buttons
(DPI/profile), and the entire G600 (its 28 bindings exceed the 12-code
neutral space, and its codes are already mutually unique — device-scoped
conduit rules cover it without onboard writes).

## Mechanism

- Onboard write: Solaar ≥ 1.1.17 profile dump → edit profile 1 only →
  load (packaged libratbag 0.18 cannot write this mouse — layout 0x05).
- Fresh YAML backup before the write, kept alongside the earlier one in
  `~/.config/conduit/`.
- Config: `~/.config/conduit/conduit.toml` default profile gains
  `f13 = "esc"` and `f14 = "space"` next to the existing `f15 = "v"`.
  F18 gets no entry — unmapped keys pass through the daemon unchanged.

## Error handling

- Daemon down → F13/F14 inert (accepted, same trade as F15); F18 unaffected.
- Rollback = `solaar profiles "G502 X PLUS" <backup>.yaml` plus reverting
  the two config lines.
- Edits scoped to profile 1 `!Button` lines only, so profiles 2–5 and
  resolutions/LED settings cannot be touched accidentally.

## Verification

- Re-dump shows 104/105 in profile 1; daemon healthy after restart.
- User: rear trigger acts as Esc, b5 as Space, everywhere; F18 button
  unchanged; per-app override works (e.g. `[profile.runelite.keys]`).
