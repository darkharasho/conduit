# Battery status in app and tray — design

**Date:** 2026-07-30
**Goal:** Show wireless-device battery percentage and charging state in the Conduit app and in the tray icon's menu.

## Data source

The kernel already exposes peripheral batteries under `/sys/class/power_supply/`
(e.g. `hidpp_battery_0` for the G502 X PLUS via `hid-logitech-hidpp`; Bluetooth
HID devices appear the same way). Nodes with `scope == Device` are peripheral
batteries — the laptop main battery has scope `System`, so filtering on scope
cleanly excludes it.

Attributes used: `model_name`, `manufacturer`, `capacity` (0–100),
`status` (`Charging` / `Discharging` / `Full` / `Not charging` / `Unknown`),
`online`, `serial_number`.

Reading sysfs directly requires **no new dependencies** (std `fs` only) and no
daemon/proto changes — battery is desktop-side info, and the tray already lives
in the Tauri app. UPower/D-Bus was considered and rejected: extra dependency,
same underlying data.

## Backend (ui/src-tauri)

New module `battery.rs`:

- `BatteryInfo { name, percentage: Option<u8>, status, charging: bool, serial }`
  — `status` normalized to lowercase (`charging`, `discharging`, `full`,
  `not-charging`, `unknown`).
- `read_batteries()` — enumerate `/sys/class/power_supply/*`, keep
  `type == Battery && scope == Device`, sorted by name for stable order.
- Tauri command `list_batteries` for on-demand reads from the UI.
- A poll thread (spawned in `.setup()`, every 30 s) reads batteries, emits a
  `conduit://battery` Tauri event with the full list, and updates the tray.

## Tray

`build_tray` gains battery lines: one **disabled** `MenuItem` per battery at the
top of the menu, then a separator, then the existing Open/Quit. Text format:

    G502 X PLUS — 27% (charging)

The poll thread re-renders these strings; when they change it rebuilds the menu
via `tray_by_id("main-tray").set_menu(...)` and sets the same text as the tray
tooltip. No batteries → menu is just Open/Quit (unchanged today's behavior).

## App UI

- `client.ts`: `BatteryInfo` type, `listBatteries()`, `onBattery(cb)`.
- New `lib/battery.ts`: `formatBattery(info)` → `"27% ⚡"` / `"27%"` / `"Full"`,
  and `batteryForDevice(batteries, physicalDevice)` — case-insensitive
  normalized substring match between battery `name` and the device card's
  name/node names (battery `G502 X PLUS` matches evdev `Logitech G502 X PLUS`).
- Home screen device cards: a small battery pill next to the state line when a
  battery matches the card; initial `listBatteries()` on mount plus live
  updates from `conduit://battery`. Wired devices (G600) simply match no
  battery and show nothing.

## Error handling

- sysfs read errors on individual attributes → attribute treated as absent;
  a node missing `capacity` still lists with `percentage: null` (UI skips it).
- Poll thread never panics; on read failure it emits an empty list and clears
  tray battery lines.

## Testing

- Rust: unit tests for the sysfs directory parser (tempdir fixture) and the
  menu line formatter, following existing `#[cfg(test)]` style in src-tauri.
- Vitest: tests for `formatBattery` and `batteryForDevice` matching; Home
  screen test updated to render a battery pill from a mocked battery list.
