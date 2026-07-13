/**
 * mouse-layouts.ts — hand-curated device layouts for popular mice.
 *
 * A curated layout gives buttons their real names ("G4 · Back", "G9" thumb
 * grid) instead of raw evdev labels, and is honest about buttons that are
 * handled by onboard firmware and emit nothing by default (`key: null`).
 *
 * Sources (researched 2026-07-12):
 * - Logitech G600 quickstart + support docs: G1-G8 on the mouse node; the
 *   12-button thumb grid (G9-G20) ships mapped to NUMPAD keys and arrives
 *   via the separate "G600 Keyboard" event node. G6 (ring finger) is the
 *   onboard G-shift modifier.
 * - Logitech G502 X / X PLUS setup guide: G1-G9 official names. Linux
 *   evtest reports confirm back/forward are BTN_SIDE/BTN_EXTRA and that
 *   DPI shift (G6), DPI up/down (G8/G7), and profile cycle (G9) are
 *   onboard-only in the default (non-G HUB) mode.
 * - G Pro X Superlight, DeathAdder V2, MX Master 3S: standard 5-button
 *   HID layouts documented across Linux wikis; extra controls noted.
 *
 * Factory defaults can be changed by onboard profiles — the Detect button
 * in Mappings verifies what a physical control really emits.
 */

export interface LayoutButton {
  /** Canonical key name, or null when the control is onboard-only. */
  key: string | null;
  /** Human label, e.g. "G4 · Back". */
  label: string;
  /** Shown as a tooltip; provenance/caveats. */
  note?: string;
}

export interface LayoutGroup {
  label: string;
  buttons: LayoutButton[];
}

export interface DeviceLayout {
  title: string;
  /** Which event node of the device this layout describes. */
  node: "mouse" | "keyboard";
  groups: LayoutGroup[];
}

interface LayoutEntry {
  vendor: number;
  product: number;
  node: "mouse" | "keyboard";
  layout: DeviceLayout;
}

const WHEEL_GROUP: LayoutGroup = {
  label: "Wheel",
  buttons: [
    { key: "wheelup", label: "Scroll up" },
    { key: "wheeldown", label: "Scroll down" },
    { key: "wheelleft", label: "Tilt left" },
    { key: "wheelright", label: "Tilt right" },
  ],
};

const G600_MOUSE: DeviceLayout = {
  title: "Logitech G600 — mouse buttons",
  node: "mouse",
  groups: [
    {
      label: "Primary",
      buttons: [
        { key: "btn_left", label: "G1 · Left" },
        { key: "btn_right", label: "G2 · Right" },
        { key: "btn_middle", label: "G3 · Wheel click" },
      ],
    },
    {
      label: "Wheel",
      buttons: [
        { key: "wheelup", label: "Scroll up" },
        { key: "wheeldown", label: "Scroll down" },
        { key: "wheelleft", label: "G4 · Tilt left" },
        { key: "wheelright", label: "G5 · Tilt right" },
      ],
    },
    {
      label: "Top & ring finger",
      buttons: [
        { key: null, label: "G7 · behind wheel", note: "Onboard: profile/DPI by default. Remap in Logitech software to emit a key, then use Detect." },
        { key: null, label: "G8 · behind wheel", note: "Onboard: profile/DPI by default. Remap in Logitech software to emit a key, then use Detect." },
        { key: null, label: "G6 · G-shift (ring finger)", note: "Onboard modifier: shifts G9–G20 to their alternate set. Emits nothing itself." },
      ],
    },
  ],
};

// Factory default: the thumb grid sends numpad keys (that's why the G600
// exposes a keyboard node). Grid order G9..G20 → kp1..kp9, kp0, kp-, kp+.
const G600_KEYBOARD: DeviceLayout = {
  title: "Logitech G600 — thumb grid (G9–G20)",
  node: "keyboard",
  groups: [
    {
      label: "Thumb grid — factory default sends numpad (verify with Detect)",
      buttons: [
        { key: "kp1", label: "G9" },
        { key: "kp2", label: "G10" },
        { key: "kp3", label: "G11" },
        { key: "kp4", label: "G12" },
        { key: "kp5", label: "G13" },
        { key: "kp6", label: "G14" },
        { key: "kp7", label: "G15" },
        { key: "kp8", label: "G16" },
        { key: "kp9", label: "G17" },
        { key: "kp0", label: "G18" },
        { key: "kpminus", label: "G19" },
        { key: "kpplus", label: "G20" },
      ].map((b) => ({
        ...b,
        note: "Factory default numpad mapping; onboard profiles can change it — press Detect, then the button, to confirm.",
      })),
    },
  ],
};

const G502X_MOUSE: DeviceLayout = {
  title: "Logitech G502 X",
  node: "mouse",
  groups: [
    {
      label: "Primary",
      buttons: [
        { key: "btn_left", label: "G1 · Left" },
        { key: "btn_right", label: "G2 · Right" },
        { key: "btn_middle", label: "G3 · Wheel click" },
      ],
    },
    {
      label: "Thumb",
      buttons: [
        { key: "mouse4", label: "G4 · Back" },
        { key: "mouse5", label: "G5 · Forward" },
      ],
    },
    WHEEL_GROUP,
    {
      label: "Built-in — the mouse handles these itself",
      buttons: [
        { key: null, label: "G6 · DPI shift (sniper)", note: "Handled by firmware — changes DPI while held. Assign it a key in G HUB/logiops to make it mappable, then Detect." },
        { key: null, label: "G7 · DPI down", note: "Handled by firmware. Assign in G HUB/logiops to make it mappable." },
        { key: null, label: "G8 · DPI up", note: "Handled by firmware. Assign in G HUB/logiops to make it mappable." },
        { key: null, label: "G9 · Profile cycle (base)", note: "Cycles onboard profiles; not remappable via input events." },
      ],
    },
  ],
};

const GPX_SUPERLIGHT: DeviceLayout = {
  title: "Logitech G Pro X Superlight",
  node: "mouse",
  groups: [
    {
      label: "Buttons",
      buttons: [
        { key: "btn_left", label: "Left" },
        { key: "btn_right", label: "Right" },
        { key: "btn_middle", label: "Wheel click" },
        { key: "mouse4", label: "Back" },
        { key: "mouse5", label: "Forward" },
      ],
    },
    {
      label: "Wheel",
      buttons: [
        { key: "wheelup", label: "Scroll up" },
        { key: "wheeldown", label: "Scroll down" },
      ],
    },
  ],
};

const DEATHADDER_V2: DeviceLayout = {
  title: "Razer DeathAdder V2",
  node: "mouse",
  groups: [
    {
      label: "Buttons",
      buttons: [
        { key: "btn_left", label: "Left" },
        { key: "btn_right", label: "Right" },
        { key: "btn_middle", label: "Wheel click" },
        { key: "mouse4", label: "Back" },
        { key: "mouse5", label: "Forward" },
      ],
    },
    {
      label: "Wheel",
      buttons: [
        { key: "wheelup", label: "Scroll up" },
        { key: "wheeldown", label: "Scroll down" },
      ],
    },
    {
      label: "Onboard",
      buttons: [
        { key: null, label: "DPI up / DPI down (top)", note: "Cycle onboard DPI stages by default; remap with Razer software/OpenRazer to emit keys." },
      ],
    },
  ],
};

const MX_MASTER_3S: DeviceLayout = {
  title: "Logitech MX Master 3S",
  node: "mouse",
  groups: [
    {
      label: "Buttons",
      buttons: [
        { key: "btn_left", label: "Left" },
        { key: "btn_right", label: "Right" },
        { key: "btn_middle", label: "Wheel click" },
        { key: "mouse4", label: "Back" },
        { key: "mouse5", label: "Forward" },
        { key: "btn_task", label: "Gesture button", note: "Under the thumb rest. Default emission varies by firmware — verify with Detect." },
      ],
    },
    {
      label: "Wheels",
      buttons: [
        { key: "wheelup", label: "Scroll up" },
        { key: "wheeldown", label: "Scroll down" },
        { key: "wheelleft", label: "Thumbwheel up" },
        { key: "wheelright", label: "Thumbwheel down" },
      ],
    },
    {
      label: "Onboard",
      buttons: [
        { key: null, label: "Wheel mode shift (top)", note: "Toggles ratchet/free-spin mechanically; emits nothing." },
      ],
    },
  ],
};

const LAYOUTS: LayoutEntry[] = [
  { vendor: 0x046d, product: 0xc24a, node: "mouse", layout: G600_MOUSE },
  { vendor: 0x046d, product: 0xc24a, node: "keyboard", layout: G600_KEYBOARD },
  // G502 X family: wired (c099), LIGHTSPEED (4098... varies), X PLUS (4099).
  { vendor: 0x046d, product: 0x4099, node: "mouse", layout: G502X_MOUSE },
  { vendor: 0x046d, product: 0xc099, node: "mouse", layout: G502X_MOUSE },
  { vendor: 0x046d, product: 0xc094, node: "mouse", layout: GPX_SUPERLIGHT },
  { vendor: 0x1532, product: 0x0084, node: "mouse", layout: DEATHADDER_V2 },
  { vendor: 0x046d, product: 0xb034, node: "mouse", layout: MX_MASTER_3S },
];

/**
 * Curated layout for a device, matched by vendor:product and node kind
 * (a "keyboard"-class node gets the keyboard layout, everything else the
 * mouse one). Null when we don't have researched data for the device.
 */
export function layoutFor(dev: {
  vendor: number;
  product: number;
  class?: string;
}): DeviceLayout | null {
  const node = dev.class === "keyboard" ? "keyboard" : "mouse";
  return (
    LAYOUTS.find(
      (e) => e.vendor === dev.vendor && e.product === dev.product && e.node === node
    )?.layout ?? null
  );
}
