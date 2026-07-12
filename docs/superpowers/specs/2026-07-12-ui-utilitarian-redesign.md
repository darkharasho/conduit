# Conduit UI — Utilitarian Redesign (approved 2026-07-12)

User-approved direction: "pure utilitarian" (see companion mockup
`2026-07-12-ui-utilitarian-mockup.html`, rendered and approved in-session).

## Design system
- Palette: near-black surfaces (#0e1013 body, #0a0c0e rails/panels, #12151a keys),
  1px borders (#1c2026 structural, #22262d controls), text hierarchy
  #e6eaef / #b8bfc9 / #8a93a0 / #525a66.
- ONE accent: desaturated teal #4db8a8 — used ONLY for meaning (mapped keys,
  active profile, selected key, live/ok status, primary action). Warning amber
  #d9a04d for Suspend. No other colors, no glows, no gradients.
- Type: system-ui for UI text (12–13px), ui-monospace for key names, TOML,
  match rules, and the status bar. Small-caps 10px labels with letterspacing.
- Radii 4–6px. Flat: no shadows except none.

## Layout (all screens)
- Left rail (216px): logo + version, nav (Mappings/Key Tester/Devices/Status)
  with keyboard shortcut hints 1–4 (real shortcuts: keys 1–4 switch screens
  when no input is focused), Profiles section below nav on Mappings only —
  each profile shows its match rule in mono small text; active profile gets
  teal left-edge bar + "● active".
- Bottom status bar (26px, mono 11px): ● daemon (teal ok / red down),
  active profile, current focus window, tap-hold timeout; right side:
  grabbed device summary, panic chord.
- Toolbar per screen: title + context small text, screen-specific controls,
  Suspend/Resume button (amber outline) on the right.

## Mappings screen
- Layer tabs as joined segment control (base | nav | … | +).
- Keyboard: 44px keycaps, 3px gaps, key name + mono action hint on two lines
  (`esc⁄ctrl`, `hold:shift`, `hold:nav`); mapped = teal-tinted bg + border;
  selected = teal inset ring. Mouse buttons compact row (38% width) below.
- Inline inspector panel below keyboard (replaces popover): header = selected
  key chip + joined segment control (remap | tap-hold | layer | disable | pass);
  body = labeled mono fields per kind + "press a key…" capture field (dashed
  border) + teal Apply button; footer = live TOML echo line:
  `conduit.toml → [profile.default.keys] capslock = { tap = "esc", ... }`.
- Empty selection: inspector shows hint text instead of fields.

## Other screens (same system)
- Key Tester: table-like rows, mono, in→out with teal outputs, "(swallowed)"
  and hold-timing badges as plain bracketed mono text, header shows active
  profile; Clear button in toolbar.
- Devices: dense table (name / vid:pid mono / type / grab checkbox), confirm
  dialog styled as inline panel not browser confirm.
- Status: definition-list style panels; SetupCheck rows keep pass/warn/fail
  but restyled (teal/amber/red dots, mono commands, copy buttons).

## Non-goals
- No logic changes: config-model.ts, event-pairing.ts, keyboard-layout.ts,
  client.ts APIs and tests stay as-is (presentation-only rebuild; small pure
  additions allowed with tests, e.g. a helper to render one action as TOML).
