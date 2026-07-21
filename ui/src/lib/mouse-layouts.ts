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

/**
 * A real product render for the click-the-picture view.
 * `markers` places each mappable key on the image, in the image's natural
 * pixel space (top-left origin). MouseIllustration scales both into its
 * viewBox, so coordinates here never need to know about display size.
 */
export interface DevicePhoto {
  /** Path under the app's public root, e.g. "/devices/g502x-top.png". */
  src: string;
  /** Natural pixel size of the image file. */
  width: number;
  height: number;
  /** Marker centers per key name, in natural pixel coordinates. */
  markers: Record<string, { x: number; y: number }>;
}

export interface DeviceLayout {
  title: string;
  /** Which event node of the device this layout describes. */
  node: "mouse" | "keyboard";
  groups: LayoutGroup[];
  /**
   * True when the device has prominent side buttons best shown in a right-profile
   * (side-view) illustration rather than the default top-down view.
   * DeviceArt and MouseIllustration both branch on this flag.
   */
  sideButtons?: boolean;
  /**
   * Real product renders (transparent PNGs) for the click-the-picture view.
   * When present, MouseIllustration draws the photo instead of vector art and
   * MouseViz offers a Top/Side toggle for whichever views exist.
   */
  photos?: { top?: DevicePhoto; side?: DevicePhoto };
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
  sideButtons: true,
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

// Keep-in-sync: the f13–f16 key codes here are written by the onboard-fix in
// crates/conduit-core/src/onboard_fix.rs (Tasks 5-6). Labels are provisional
// index-order assignments; Task 8 live-verifies and corrects if needed.
const G502X_MOUSE: DeviceLayout = {
  title: "Logitech G502 X",
  node: "mouse",
  // Side profile shown in DeviceArt / MouseIllustration when this is true.
  sideButtons: true,
  // Official product renders (transparent PNGs, ui/public/devices/).
  // Marker coordinates are in each image's natural pixel space. Views split
  // by where the physical control lives — top view: primary buttons, G8/G7
  // on the left edge, G9 behind the wheel (the mechanical ratchet toggle
  // above it emits nothing and gets no marker); side view: thumb buttons
  // G4/G5 and the DPI-shift paddle.
  photos: {
    top: {
      // ?v=3 busts webview caches from earlier crops (public/ assets keep
      // their URL across builds, so stale copies survive otherwise).
      src: "/devices/g502x-top.png?v=3",
      width: 461,
      height: 715,
      markers: {
        btn_left:   { x: 140, y: 218 },
        btn_right:  { x: 345, y: 218 },
        btn_middle: { x: 267, y: 183 },
        // Top-left edge pair (printed G8 front, G7 rear). Live-verified
        // 2026-07-20 via output capture: G8 emits F20, G7 emits F21 (onboard
        // slots b10/b11, rewired from onboard specials by the one-time fix).
        f20:        { x: 112, y: 126 }, // Top front button (G8)
        f21:        { x: 106, y: 185 }, // Top rear button (G7)
        f16:        { x: 267, y: 326 }, // G9 — behind the wheel
      },
    },
    side: {
      src: "/devices/g502x-side.png?v=3",
      width: 949,
      height: 509,
      markers: {
        // Side pair (printed G5 front / G4 rear), user-verified 2026-07-20:
        // these are the F13/F14 buttons from the onboard fix (Solaar's b3
        // "rear trigger" = F13 rear, b5 = F14 front) — NOT Back/Forward.
        f14:        { x: 445, y: 275 }, // Side front button — types Space
        f13:        { x: 565, y: 265 }, // Side rear button — types Esc
        f15:        { x: 365, y: 350 }, // Thumb button (b4) — DPI-shift paddle
      },
    },
  },
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
      // Live-verified 2026-07-20: the top-left pair emits F20/F21 after the
      // onboard fix rewired their special slots (b10/b11). Nothing on this
      // mouse emits Back/Forward (mouse4/mouse5).
      label: "Top pair",
      buttons: [
        { key: "f20", label: "Top front button", note: "Printed G8 — rewired to F20 by the one-time onboard fix (was an onboard DPI control)." },
        { key: "f21", label: "Top rear button", note: "Printed G7 — rewired to F21 by the one-time onboard fix (was an onboard DPI control)." },
      ],
    },
    WHEEL_GROUP,
    {
      label: "Extra buttons (after one-time fix)",
      buttons: [
        {
          key: "f14",
          label: "Side front button",
          note: "Front side (thumb) button, printed G5 — rewired to F14 by the one-time onboard fix (originally typed Space).",
        },
        {
          key: "f13",
          label: "Side rear button",
          note: "Rear side (thumb) button, printed G4 — rewired to F13 by the one-time onboard fix (originally typed Esc; Solaar names it the rear trigger).",
        },
        {
          key: "f15",
          label: "Thumb button",
          note: "DPI-shift paddle by the thumb — rewired to F15 by the one-time onboard fix (originally typed v). Position live-verified 2026-07-20.",
        },
        {
          key: "f16",
          label: "Rear trigger",
          note: "G9-group side button — rewired to F16 by the one-time onboard fix. NOTE: the 2026-07-20 Solaar dump shows the fourth button (b8) emitting F18, not F16 — verify with Detect.",
        },
      ],
    },
    {
      label: "Built-in — not remappable",
      buttons: [
        {
          key: null,
          label: "G9 · Profile cycle (base)",
          note: "Cycles onboard profiles; not remappable via input events.",
        },
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
