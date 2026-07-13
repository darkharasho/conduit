# Experience Redesign Phase 2: Shell & Home Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four-peer-screen navigation with the spec's home → device → help structure: a "Your devices" card grid opens the app, the daemon dot and Suspend ceremony disappear, and a paused state becomes an unmissable banner (spec `docs/superpowers/specs/2026-07-13-experience-redesign-design.md`, Sections 1–2).

**Architecture:** A new `device-registry` module groups evdev nodes into physical devices and resolves curated names/archetypes (extending the curated set already in `mouse-layouts.ts`). A new Home screen renders device cards, remembered devices, and empty states, with errors going through Phase 1's `presentError`. `App.tsx` switches from a `Screen` union to a `View` union (home/device/help); the existing Mappings screen becomes the device view (reached from a card, back-navigable), Status + Key Tester + the hardware table move into a Help screen. Titlebar owns "Pause Conduit"; the bottom status bar and the word "daemon" disappear from the UI.

**Tech Stack:** React 18 + TypeScript (vitest + @testing-library/react, jsdom), one small Rust change in `conduit-daemon`.

## Global Constraints

- Before any `cargo` command: `export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig`.
- Vitest worker cap is 2 via `ui/vitest.config.ts` — run `npx vitest run` from `ui/`, never raise workers.
- Jargon ban in all new UI copy: the words "daemon", "socket", "evdev", "uinput", "selector", raw hex VID:PID, and `key:N` codes must not render. (Existing screens keep their copy until their own phase.)
- Spec copy verbatim where quoted: heading "Your devices"; subtitle "Click a device to change what its buttons do."; section "Remembered devices"; remembered note "Its settings are saved and will come back when you plug it in."; empty state "Plug in a mouse or keyboard to get started".
- Visual tokens: use the EXISTING App.css token system (`--teal`, `--bg-key`, `--text-mid`, `--r6`, etc., defined at App.css:11–46). The mockups' exact palette is the Phase 6 polish pass — structure now, current skin.
- All styles go in `ui/src/App.css` (the project keeps component styles there; it is 1943 lines — append sections with clear comment banners, do not reorganize).
- The TOML config format does not change. No proto changes in this phase.
- Every task ends green: `cd ui && npx vitest run && npx tsc --noEmit` (plus `cargo test -p conduit-daemon` for Task 1).

---

### Task 1: Daemon — GetConfig read failure becomes `internal`

The Phase 1 final review flagged that a `GetConfig` *read* failure carries `apply-failed`, whose UI copy ("The change couldn't be saved…") is wrong for a read. Remap it before screens start rendering `presentError` output.

**Files:**
- Modify: `crates/conduit-daemon/src/ipc.rs` (the `Request::GetConfig` arm in `dispatch()`, ~line 202: currently `Response::error_detail(ErrorCode::ApplyFailed, "could not read config file", e.to_string())`)

**Interfaces:**
- Consumes: `Response::error_detail`, `ErrorCode` (Phase 1).
- Produces: `GetConfig` read failures now carry `ErrorCode::Internal`. No signature changes.

- [ ] **Step 1: Refactor the read into a testable helper and write the failing test**

Extract the `GetConfig` arm's body into a free function in `ipc.rs` (next to `set_config`):

```rust
/// Read the config file for a GetConfig request. A read failure is an
/// internal fault (the daemon creates the file at startup), not an
/// apply failure — the UI copy for `apply-failed` claims "the change
/// couldn't be saved", which is wrong here.
fn read_config_response(config_path: &std::path::Path) -> Response {
    match std::fs::read_to_string(config_path) {
        Ok(toml) => Response::Config { toml },
        Err(e) => Response::error_detail(
            ErrorCode::Internal,
            "could not read config file",
            e.to_string(),
        ),
    }
}
```

Have the `Request::GetConfig` arm call `read_config_response(config_path)` and write the response exactly as before. Add the test:

```rust
    #[test]
    fn get_config_read_failure_is_internal_not_apply_failed() {
        let missing = std::path::Path::new("/nonexistent/conduit-test/conduit.toml");
        match read_config_response(missing) {
            Response::Err { code, detail, .. } => {
                assert_eq!(code, conduit_proto::ErrorCode::Internal);
                assert!(!detail.is_empty());
            }
            other => panic!("expected Err, got {other:?}"),
        }
    }
```

- [ ] **Step 2: Run to verify the new test fails before the remap** (if you changed the code first, temporarily assert `ApplyFailed` to see it fail honestly, then restore)

Run: `cargo test -p conduit-daemon get_config_read_failure`
Expected: PASS after the remap; the pre-existing suite must also stay green.

- [ ] **Step 3: Full daemon suite**

Run: `cargo test -p conduit-daemon`
Expected: all green (74 tests incl. the new one).

- [ ] **Step 4: Commit**

```bash
git add crates/conduit-daemon/src/ipc.rs
git commit -m "fix(daemon): GetConfig read failure is internal, not apply-failed"
```

---

### Task 2: Device registry — physical devices, names, archetypes, remembered devices

**Files:**
- Create: `ui/src/lib/device-registry.ts`
- Test: `ui/src/lib/device-registry.test.ts`

**Interfaces:**
- Consumes: `DeviceInfo` from `./client` (fields: `path, name, vendor, product, grabbed, id, class, phys, keys`), `ConfigModel` + `selectorMatches(entry, dev)` from `./config-model` (config-model.ts:428).
- Produces (Tasks 3–5 rely on these exact names):

```typescript
export type Archetype = "gaming-mouse" | "mmo-mouse" | "mouse" | "keyboard";
export interface PhysicalDevice {
  key: string;          // "046d:c24a" — lowercase 4-hex-digit vendor:product
  name: string;         // curated name, else cleaned node name
  archetype: Archetype;
  nodes: DeviceInfo[];  // every evdev node grouped under this device
}
export interface RememberedDevice {
  selector: string;     // raw config selector, e.g. "046d:c24a/G600"
  key: string;          // "046d:c24a"
  name: string;
  archetype: Archetype;
}
export function resolveDevice(vendor: number, product: number, fallbackName: string, cls: string): { name: string; archetype: Archetype };
export function groupPhysicalDevices(devices: DeviceInfo[]): PhysicalDevice[];
export function rememberedDevices(model: ConfigModel, connected: DeviceInfo[]): RememberedDevice[];
export function appProfileCount(model: ConfigModel): number;
export function deviceOverrideCount(model: ConfigModel, phys: PhysicalDevice): number;
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";
import type { DeviceInfo } from "./client";
import { parseConfigToml } from "./config-model";
import {
  appProfileCount,
  deviceOverrideCount,
  groupPhysicalDevices,
  rememberedDevices,
  resolveDevice,
} from "./device-registry";

function node(over: Partial<DeviceInfo>): DeviceInfo {
  return {
    path: "/dev/input/event0", name: "Some Device", vendor: 0x1111,
    product: 0x2222, is_keyboard: false, is_mouse: true, grabbed: false,
    id: "1111:2222/Some Device", class: "mouse", phys: "", keys: [],
    wheel: false, hwheel: false, ...over,
  };
}

describe("resolveDevice", () => {
  it("returns curated names for known hardware", () => {
    expect(resolveDevice(0x046d, 0xc24a, "Logitech Gaming Mouse G600", "mouse"))
      .toEqual({ name: "Logitech G600", archetype: "mmo-mouse" });
    expect(resolveDevice(0x046d, 0x4099, "whatever", "mouse").name)
      .toBe("Logitech G502 X");
    expect(resolveDevice(0x31e3, 0x1402, "whatever", "keyboard"))
      .toEqual({ name: "Wooting 80HE", archetype: "keyboard" });
  });
  it("falls back to the node name and class archetype", () => {
    expect(resolveDevice(0x9999, 0x0001, "Acme SuperMouse", "mouse"))
      .toEqual({ name: "Acme SuperMouse", archetype: "mouse" });
    expect(resolveDevice(0x9999, 0x0002, "Acme Board", "keyboard").archetype)
      .toBe("keyboard");
  });
});

describe("groupPhysicalDevices", () => {
  it("groups multi-node hardware into one card and keeps input-class devices only", () => {
    const devices = [
      node({ vendor: 0x046d, product: 0xc24a, class: "mouse", name: "Logitech Gaming Mouse G600", path: "/dev/input/event12" }),
      node({ vendor: 0x046d, product: 0xc24a, class: "keyboard", name: "Logitech Gaming Mouse G600 Keyboard", path: "/dev/input/event13" }),
      node({ vendor: 0x046d, product: 0xc24a, class: "other", name: "Logitech Gaming Mouse G600", path: "/dev/input/event14" }),
      node({ vendor: 0x0000, product: 0x0001, class: "media", name: "Power Button" }),
    ];
    const phys = groupPhysicalDevices(devices);
    expect(phys).toHaveLength(1);
    expect(phys[0].key).toBe("046d:c24a");
    expect(phys[0].name).toBe("Logitech G600");
    expect(phys[0].nodes).toHaveLength(3); // "other" sibling rides along
  });
  it("excludes virtual/passthrough devices and non-input classes", () => {
    const devices = [
      node({ vendor: 0xbeef, product: 0xdead, class: "keyboard", name: "Keyboard passthrough" }),
      node({ vendor: 0x2333, product: 0x6666, class: "gamepad", name: "ydotoold virtual device" }),
      node({ vendor: 0x0000, product: 0x0000, class: "other", name: "HD-Audio Generic Line" }),
    ];
    expect(groupPhysicalDevices(devices)).toHaveLength(0);
  });
});

describe("remembered + investment", () => {
  const toml = `
[profile.default.keys]
capslock = "esc"

[profile.firefox]
match = { class = "firefox" }
[profile.firefox.keys]
f1 = "back"

[profile.default.device."046d:c24a/G600".keys]
mouse4 = "copy"
mouse5 = "paste"
`;
  const model = parseConfigToml(toml);

  it("lists device sections with no connected match as remembered", () => {
    const rem = rememberedDevices(model, []);
    expect(rem).toHaveLength(1);
    expect(rem[0]).toMatchObject({
      selector: '046d:c24a/G600', key: "046d:c24a",
      name: "Logitech G600", archetype: "mmo-mouse",
    });
  });
  it("does not list sections whose device is connected", () => {
    const g600 = node({ vendor: 0x046d, product: 0xc24a, class: "mouse", name: "G600", id: "046d:c24a/G600" });
    expect(rememberedDevices(model, [g600])).toHaveLength(0);
  });
  it("counts app profiles and device overrides", () => {
    expect(appProfileCount(model)).toBe(1); // firefox
    const g600 = groupPhysicalDevices([
      node({ vendor: 0x046d, product: 0xc24a, class: "mouse", name: "G600", id: "046d:c24a/G600" }),
    ])[0];
    expect(deviceOverrideCount(model, g600)).toBe(2); // mouse4 + mouse5
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/lib/device-registry.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `device-registry.ts`**

```typescript
import type { DeviceInfo } from "./client";
import type { ConfigModel } from "./config-model";
import { selectorMatches } from "./config-model";

export type Archetype = "gaming-mouse" | "mmo-mouse" | "mouse" | "keyboard";

export interface PhysicalDevice {
  key: string;
  name: string;
  archetype: Archetype;
  nodes: DeviceInfo[];
}

export interface RememberedDevice {
  selector: string;
  key: string;
  name: string;
  archetype: Archetype;
}

interface CuratedEntry { name: string; archetype: Archetype; }

// Curated identities. Superset of the layouts in mouse-layouts.ts —
// keep the two in sync when adding hardware.
const CURATED: Record<string, CuratedEntry> = {
  "046d:c24a": { name: "Logitech G600", archetype: "mmo-mouse" },
  "046d:4099": { name: "Logitech G502 X", archetype: "gaming-mouse" },
  "046d:c099": { name: "Logitech G502 X", archetype: "gaming-mouse" },
  "046d:c094": { name: "Logitech G Pro X Superlight", archetype: "gaming-mouse" },
  "1532:0084": { name: "Razer DeathAdder V2", archetype: "gaming-mouse" },
  "046d:b034": { name: "Logitech MX Master 3S", archetype: "mouse" },
  "31e3:1402": { name: "Wooting 80HE", archetype: "keyboard" },
  "046d:c548": { name: "Logitech Wireless Receiver", archetype: "mouse" },
};

// Virtual/injection devices that must never appear as user hardware.
const DENYLIST = /passthrough|virtual|ydotool|conduit/i;

const INPUT_CLASSES = new Set(["keyboard", "mouse", "touchpad"]);

function hex4(n: number): string {
  return n.toString(16).padStart(4, "0");
}

export function physKey(vendor: number, product: number): string {
  return `${hex4(vendor)}:${hex4(product)}`;
}

export function resolveDevice(
  vendor: number,
  product: number,
  fallbackName: string,
  cls: string,
): { name: string; archetype: Archetype } {
  const curated = CURATED[physKey(vendor, product)];
  if (curated) return { name: curated.name, archetype: curated.archetype };
  const archetype: Archetype = cls === "keyboard" ? "keyboard" : "mouse";
  return { name: fallbackName, archetype };
}

export function groupPhysicalDevices(devices: DeviceInfo[]): PhysicalDevice[] {
  const groups = new Map<string, DeviceInfo[]>();
  for (const d of devices) {
    if (d.vendor === 0 || DENYLIST.test(d.name)) continue;
    const key = physKey(d.vendor, d.product);
    const list = groups.get(key) ?? [];
    list.push(d);
    groups.set(key, list);
  }
  const out: PhysicalDevice[] = [];
  for (const [key, nodes] of groups) {
    const primary =
      nodes.find((n) => INPUT_CLASSES.has(n.class)) ?? null;
    if (!primary) continue; // no input-class node → not user hardware
    const { name, archetype } = resolveDevice(
      primary.vendor, primary.product, primary.name, primary.class,
    );
    out.push({ key, name, archetype, nodes });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function rememberedDevices(
  model: ConfigModel,
  connected: DeviceInfo[],
): RememberedDevice[] {
  const seen = new Map<string, RememberedDevice>();
  for (const profile of model.profiles) {
    for (const selector of Object.keys(profile.device ?? {})) {
      if (connected.some((d) => selectorMatches(selector, d))) continue;
      if (seen.has(selector)) continue;
      // Selector shapes (config-model.ts): "vid:pid", "name", "vid:pid/name", optional "@phys".
      const base = selector.split("@")[0];
      const [head, tail] = base.includes("/")
        ? [base.slice(0, base.indexOf("/")), base.slice(base.indexOf("/") + 1)]
        : [base, base];
      const m = /^([0-9a-f]{4}):([0-9a-f]{4})$/i.exec(head);
      const vendor = m ? parseInt(m[1], 16) : 0;
      const product = m ? parseInt(m[2], 16) : 0;
      const { name, archetype } = resolveDevice(vendor, product, tail, "mouse");
      seen.set(selector, { selector, key: m ? physKey(vendor, product) : base, name, archetype });
    }
  }
  return [...seen.values()];
}

export function appProfileCount(model: ConfigModel): number {
  return model.profiles.filter(
    (p) => p.name !== "default" && Object.keys(p.keys ?? {}).length > 0,
  ).length;
}

export function deviceOverrideCount(
  model: ConfigModel,
  phys: PhysicalDevice,
): number {
  let count = 0;
  for (const profile of model.profiles) {
    for (const [selector, section] of Object.entries(profile.device ?? {})) {
      if (phys.nodes.some((n) => selectorMatches(selector, n))) {
        count += Object.keys(section.keys ?? {}).length;
      }
    }
  }
  return count;
}
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/lib/device-registry.test.ts`
Expected: PASS. Then full suite: `npx vitest run` — all green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/device-registry.ts ui/src/lib/device-registry.test.ts
git commit -m "feat(ui): device registry with curated names, grouping, remembered devices"
```

---

### Task 3: DeviceArt — archetype illustrations

**Files:**
- Create: `ui/src/components/DeviceArt.tsx`
- Test: `ui/src/components/DeviceArt.test.tsx`

**Interfaces:**
- Consumes: `Archetype` from `../lib/device-registry`.
- Produces: `DeviceArt({ archetype, width }: { archetype: Archetype; width?: number }): JSX.Element` — an inline `<svg role="img">` with `aria-label` = archetype. Task 4 renders it inside cards; the remembered row renders it at small width with reduced opacity via the `device-art--dim` class on a wrapper (Task 4's CSS).

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeviceArt } from "./DeviceArt";

describe("DeviceArt", () => {
  it.each(["gaming-mouse", "mmo-mouse", "mouse", "keyboard"] as const)(
    "renders an svg for %s",
    (archetype) => {
      render(<DeviceArt archetype={archetype} />);
      const img = screen.getByRole("img", { name: archetype });
      expect(img.tagName.toLowerCase()).toBe("svg");
    },
  );
  it("honors the width prop", () => {
    render(<DeviceArt archetype="mouse" width={24} />);
    expect(screen.getByRole("img", { name: "mouse" })).toHaveAttribute("width", "24");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/components/DeviceArt.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

The art language follows the approved mockups (angular gaming mouse, top view) but with the CURRENT token palette: body fill `var(--bg-key)`, strokes `var(--border-control)`, accents `var(--teal)`. Complete component:

```tsx
import type { Archetype } from "../lib/device-registry";

interface Props {
  archetype: Archetype;
  width?: number;
}

/** Mouse body outline shared by the three mouse archetypes. */
function MouseBody({ children }: { children?: React.ReactNode }) {
  return (
    <>
      <path
        d="M48 4 C 66 4 78 15 81 32 C 83 44 79 52 80 62 C 82 82 84 100 74 115 C 67 126 56 130 48 130 C 38 130 28 125 22 114 C 14 99 16 82 18 64 C 19 52 14 44 16 32 C 19 15 31 4 48 4 Z"
        fill="var(--bg-key)" stroke="var(--border-control)" strokeWidth="1.5"
      />
      <path d="M48 4 L 48 22" stroke="var(--bg-body)" strokeWidth="2" />
      <path d="M17 34 C 30 40 42 41 48 41 C 54 41 66 40 79 34" stroke="var(--bg-body)" strokeWidth="2" fill="none" />
      <rect x="42" y="16" width="12" height="24" rx="6" fill="var(--bg-body)" />
      <rect x="44" y="18" width="8" height="20" rx="4" fill="var(--bg-key)" stroke="var(--teal)" strokeWidth="1" />
      {children}
    </>
  );
}

export function DeviceArt({ archetype, width = 96 }: Props) {
  const mouseView = "0 0 96 134";
  const kbView = "0 0 120 60";
  const isMouse = archetype !== "keyboard";
  return (
    <svg
      role="img"
      aria-label={archetype}
      width={width}
      viewBox={isMouse ? mouseView : kbView}
      className="device-art"
    >
      {archetype === "gaming-mouse" && (
        <MouseBody>
          <path d="M19 50 L 26 48 L 27 56 L 20 58 Z" fill="var(--bg-body)" stroke="var(--teal)" strokeWidth="1" />
          <path d="M20 61 L 27 59 L 28 67 L 21 69 Z" fill="var(--bg-body)" stroke="var(--teal)" strokeWidth="1" opacity=".7" />
          <path d="M32 104 L 48 96 L 64 104" stroke="var(--teal)" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".8" />
          <path d="M35 112 L 48 105 L 61 112" stroke="var(--teal)" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".4" />
        </MouseBody>
      )}
      {archetype === "mmo-mouse" && (
        <MouseBody>
          {/* 4×3 thumb grid — the MMO signature */}
          {[0, 1, 2, 3].map((r) =>
            [0, 1, 2].map((c) => (
              <rect
                key={`${r}-${c}`}
                x={14 + c * 7} y={48 + r * 10}
                width="6" height="8" rx="1.5"
                fill="var(--bg-body)" stroke="var(--teal)" strokeWidth="0.8" opacity=".8"
              />
            )),
          )}
        </MouseBody>
      )}
      {archetype === "mouse" && (
        <MouseBody>
          <path d="M20 52 L 27 50 L 28 58 L 21 60 Z" fill="var(--bg-body)" stroke="var(--border-control)" strokeWidth="1" />
        </MouseBody>
      )}
      {archetype === "keyboard" && (
        <>
          <rect x="2" y="8" width="116" height="44" rx="7" fill="var(--bg-key)" stroke="var(--border-control)" strokeWidth="1.5" />
          {[15, 26, 37].map((y, row) =>
            Array.from({ length: row === 2 ? 5 : 9 }, (_, i) => (
              <rect
                key={`${y}-${i}`}
                x={9 + i * (row === 2 ? 21 : 12)} y={y}
                width={row === 2 && i === 2 ? 40 : 9} height="8" rx="2"
                fill="var(--bg-body)" stroke="var(--border-control)" strokeWidth="0.7"
              />
            )),
          )}
          <path d="M9 54 L 111 54" stroke="var(--teal)" strokeWidth="1.5" strokeLinecap="round" opacity=".5" />
        </>
      )}
    </svg>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/components/DeviceArt.test.tsx` then `npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/DeviceArt.tsx ui/src/components/DeviceArt.test.tsx
git commit -m "feat(ui): archetype device illustrations"
```

---

### Task 4: Home screen

**Files:**
- Create: `ui/src/screens/Home.tsx`
- Test: `ui/src/screens/Home.test.tsx`
- Modify: `ui/src/App.css` (append a `/* ── Home screen ─── */` section)

**Interfaces:**
- Consumes: `groupPhysicalDevices`, `rememberedDevices`, `appProfileCount`, `deviceOverrideCount`, `PhysicalDevice` (Task 2); `DeviceArt` (Task 3); `listDevices`, `ConduitError` from `../lib/client`; `presentError` from `../lib/error-messages`; `ConfigModel` from `../lib/config-model`.
- Produces (Task 5 relies on): `HomeScreen({ model, connected, onOpenDevice }: { model: ConfigModel | null; connected: boolean | null; onOpenDevice: (d: PhysicalDevice) => void })`.

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo } from "../lib/client";
import { parseConfigToml } from "../lib/config-model";
import { HomeScreen } from "./Home";

const mockListDevices = vi.fn();
vi.mock("../lib/client", async (orig) => ({
  ...(await orig()) as object,
  listDevices: (...a: unknown[]) => mockListDevices(...a),
}));

function node(over: Partial<DeviceInfo>): DeviceInfo {
  return {
    path: "/dev/input/event0", name: "Some Device", vendor: 0x046d,
    product: 0x4099, is_keyboard: false, is_mouse: true, grabbed: true,
    id: "046d:4099/x", class: "mouse", phys: "", keys: [], wheel: true,
    hwheel: false, ...over,
  };
}

const MODEL = parseConfigToml(`
[profile.default.keys]
capslock = "esc"
[profile.firefox]
match = { class = "firefox" }
[profile.firefox.keys]
f1 = "back"
[profile.default.device."046d:c24a/G600".keys]
mouse4 = "copy"
`);

beforeEach(() => mockListDevices.mockReset());

describe("HomeScreen", () => {
  it("renders heading, a card per physical device, and opens on click", async () => {
    mockListDevices.mockResolvedValue([node({})]);
    const onOpen = vi.fn();
    render(<HomeScreen model={MODEL} connected={true} onOpenDevice={onOpen} />);
    expect(screen.getByText("Your devices")).toBeInTheDocument();
    expect(screen.getByText("Click a device to change what its buttons do.")).toBeInTheDocument();
    const card = await screen.findByRole("button", { name: /Logitech G502 X/ });
    expect(screen.getByText("Working")).toBeInTheDocument();
    await userEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ key: "046d:4099", name: "Logitech G502 X" }),
    );
  });

  it("shows remembered devices with the spec copy", async () => {
    mockListDevices.mockResolvedValue([node({})]);
    render(<HomeScreen model={MODEL} connected={true} onOpenDevice={() => {}} />);
    expect(await screen.findByText("Remembered devices")).toBeInTheDocument();
    expect(screen.getByText(/Logitech G600 — not connected/)).toBeInTheDocument();
    expect(screen.getByText("Its settings are saved and will come back when you plug it in.")).toBeInTheDocument();
  });

  it("shows the empty state when nothing is connected", async () => {
    mockListDevices.mockResolvedValue([]);
    render(<HomeScreen model={null} connected={true} onOpenDevice={() => {}} />);
    expect(await screen.findByText("Plug in a mouse or keyboard to get started")).toBeInTheDocument();
  });

  it("renders plain-language errors through presentError, never raw strings", async () => {
    const { ConduitError } = await import("../lib/client");
    mockListDevices.mockRejectedValue(
      new ConduitError("engine-not-running", "connect refused", "conduit.sock ECONNREFUSED"),
    );
    render(<HomeScreen model={null} connected={false} onOpenDevice={() => {}} />);
    expect(await screen.findByText("Conduit's engine isn't running")).toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED|conduit\.sock/)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/screens/Home.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `Home.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";
import { DeviceArt } from "../components/DeviceArt";
import { ConduitError, listDevices, type DeviceInfo } from "../lib/client";
import type { ConfigModel } from "../lib/config-model";
import {
  appProfileCount,
  deviceOverrideCount,
  groupPhysicalDevices,
  rememberedDevices,
  type PhysicalDevice,
} from "../lib/device-registry";
import { presentError, type ErrorPresentation } from "../lib/error-messages";

interface Props {
  model: ConfigModel | null;
  connected: boolean | null;
  onOpenDevice: (d: PhysicalDevice) => void;
}

function investmentLine(model: ConfigModel | null, phys: PhysicalDevice): string {
  if (!model) return "";
  const overrides = deviceOverrideCount(model, phys);
  const apps = appProfileCount(model);
  const parts: string[] = [];
  if (overrides > 0) parts.push(`${overrides} button${overrides === 1 ? "" : "s"} set just for this device`);
  if (apps > 0) parts.push(`custom in ${apps} app${apps === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "Using normal behavior";
}

export function HomeScreen({ model, connected, onOpenDevice }: Props) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [error, setError] = useState<ErrorPresentation | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    listDevices()
      .then((d) => setDevices(d))
      .catch((e) => {
        setDevices([]);
        setError(presentError(e instanceof ConduitError ? e : new ConduitError("unknown", String(e))));
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, connected]);

  const phys = groupPhysicalDevices(devices ?? []);
  const remembered = model ? rememberedDevices(model, devices ?? []) : [];
  const loaded = devices !== null;

  return (
    <div className="home">
      <h1 className="home__title">Your devices</h1>
      <div className="home__sub">Click a device to change what its buttons do.</div>

      {error && (
        <div className="home__error" role="alert">
          <div className="home__error-title">{error.title}</div>
          <div className="home__error-body">{error.body}</div>
          {error.action === "retry" && (
            <button className="btn" onClick={refresh}>Try again</button>
          )}
        </div>
      )}

      {loaded && !error && phys.length === 0 && (
        <div className="home__empty">
          <DeviceArt archetype="mouse" width={72} />
          <div className="home__empty-text">Plug in a mouse or keyboard to get started</div>
        </div>
      )}

      <div className="home__grid">
        {phys.map((d) => (
          <button key={d.key} className="device-card" onClick={() => onOpenDevice(d)}>
            <span className="device-card__art"><DeviceArt archetype={d.archetype} /></span>
            <span className="device-card__info">
              <span className="device-card__name">{d.name}</span>
              <span className="device-card__state">
                <span className={`device-card__dot${connected === true ? " device-card__dot--ok" : ""}`} />
                {connected === true ? "Working" : "Waiting for Conduit's engine"}
              </span>
              <span className="device-card__meta">{investmentLine(model, d)}</span>
            </span>
            <span className="device-card__chev" aria-hidden>›</span>
          </button>
        ))}
      </div>

      {remembered.length > 0 && (
        <div className="home__remembered">
          <h2 className="home__remembered-title">Remembered devices</h2>
          {remembered.map((r) => (
            <div key={r.selector} className="remembered-row">
              <span className="device-art--dim"><DeviceArt archetype={r.archetype} width={26} /></span>
              <span>
                <span className="remembered-row__name">{r.name} — not connected</span>
                <span className="remembered-row__note">Its settings are saved and will come back when you plug it in.</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Append CSS to App.css** (banner comment + classes; existing token vars only)

```css
/* ── Home screen ─────────────────────────────────────────────────────── */
.home { padding: 36px 48px; overflow-y: auto; }
.home__title { font-size: 20px; font-weight: 650; color: var(--text-hi); }
.home__sub { margin-top: 5px; font-size: 13px; color: var(--text-lo); }
.home__grid { margin-top: 24px; display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
.device-card {
  display: flex; align-items: center; gap: 20px; text-align: left;
  padding: 20px; background: var(--bg-rail); border: 1px solid var(--border-structural);
  border-radius: var(--r6); cursor: pointer; position: relative;
  font: inherit; color: inherit;
}
.device-card:hover { border-color: var(--border-control); background: var(--bg-key); }
.device-card__art { flex-shrink: 0; display: flex; }
.device-card__info { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.device-card__name { font-size: 15px; font-weight: 600; color: var(--text-hi); }
.device-card__state { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--text-mid); }
.device-card__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-dim); }
.device-card__dot--ok { background: var(--teal); }
.device-card__meta { font-size: 12px; color: var(--text-lo); }
.device-card__chev { position: absolute; right: 16px; color: var(--text-dim); font-size: 16px; }
.home__remembered { margin-top: 36px; }
.home__remembered-title { font-size: 11px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--text-dim); }
.remembered-row {
  margin-top: 10px; display: flex; align-items: center; gap: 14px;
  padding: 12px 16px; border: 1px dashed var(--border-structural);
  border-radius: var(--r6); max-width: 520px;
}
.device-art--dim { opacity: .45; display: flex; }
.remembered-row__name { display: block; font-size: 13px; font-weight: 550; color: var(--text-mid); }
.remembered-row__note { display: block; margin-top: 2px; font-size: 12px; color: var(--text-lo); }
.home__empty { margin-top: 48px; display: flex; flex-direction: column; align-items: center; gap: 14px; }
.home__empty-text { font-size: 14px; color: var(--text-mid); }
.home__error { margin-top: 20px; padding: 14px 18px; border: 1px solid var(--amber-border); border-radius: var(--r6); max-width: 520px; }
.home__error-title { font-size: 14px; font-weight: 600; color: var(--text-hi); }
.home__error-body { margin-top: 4px; font-size: 13px; color: var(--text-mid); }
```

- [ ] **Step 5: Run tests**

Run: `cd ui && npx vitest run src/screens/Home.test.tsx` then `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/screens/Home.tsx ui/src/screens/Home.test.tsx ui/src/App.css
git commit -m "feat(ui): Your devices home screen with cards, remembered devices, empty state"
```

---

### Task 5: Shell rework — View union, home-first navigation, status bar removal

**Files:**
- Modify: `ui/src/App.tsx` (Screen union at :25, NAV_ITEMS :27–32, activeScreen :35, shortcut handler :133–147, rail :182–240, screen switch :149–170, status bar :307–337)
- Modify: `ui/src/screens/Mappings.tsx` (new optional prop; devices load at :46–50)
- Modify: `ui/src/App.test.tsx`
- Modify: `ui/src/App.css` (append shell section)

**Interfaces:**
- Consumes: `HomeScreen` + `PhysicalDevice` (Tasks 2/4).
- Produces (Task 6/7 rely on):
  - `type View = { kind: "home" } | { kind: "device"; devPath: string; title: string } | { kind: "help" }` in App.tsx.
  - `MappingsScreen` gains optional prop `focusDevicePath?: string` — when set and a device with that path exists after the device list loads, it becomes the active device tab (one-shot, on load).
  - The old 4-screen nav rail is REMOVED. In `view.kind === "device"`, the rail shows a `‹ Your devices` back button (class `rail__back`) above the existing profiles section (which is otherwise unchanged). In `home`/`help`, no rail column renders (grid becomes a single column).
  - The bottom status bar (App.tsx:307–337) is deleted entirely, including the word "daemon". Its information lives in the Status screen (reachable via Help, Task 7 wires it).
  - When `connected === false`, the home view is REPLACED by a centered `SetupCheck` (existing component) — interim recovery until Phase 5. Device/help views stay reachable.
  - Keyboard shortcuts "1"–"4" are removed (the handler is deleted; a fresh shortcut scheme is deferred to Phase 6).
  - A "Help & troubleshooting" link (class `home-shell__help-link`) renders below home content and switches to `{ kind: "help" }`. Task 7 provides the actual Help screen; UNTIL Task 7, clicking it renders the existing `StatusScreen` as a stand-in (Task 7 swaps one line).

- [ ] **Step 1: Update App.test.tsx first (failing tests)** — replace assertions about the old nav with the new expectations:

```tsx
// REPLACE tests that asserted the 4 nav buttons / status bar with:
it("opens on the home screen with no daemon jargon", async () => {
  render(<App />);
  expect(await screen.findByText("Your devices")).toBeInTheDocument();
  expect(screen.queryByText(/daemon/i)).toBeNull();
  expect(document.querySelector(".status-bar")).toBeNull();
});

it("navigates home → device editor → back", async () => {
  render(<App />);
  const card = await screen.findByRole("button", { name: /Logitech G502 X/ });
  await userEvent.click(card);
  expect(await screen.findByText(/‹ Your devices/)).toBeInTheDocument();
  await userEvent.click(screen.getByText(/‹ Your devices/));
  expect(await screen.findByText("Your devices")).toBeInTheDocument();
});
```

The existing client mock (App.test.tsx:18–36) needs `listDevices` to resolve a G502 X node (vendor 0x046d, product 0x4099, class "mouse", grabbed true) so home has one card, and keep every previously-mocked function.

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/App.test.tsx`
Expected: FAIL — home screen not rendered by App.

- [ ] **Step 3: Implement the App.tsx rework**

```tsx
type View =
  | { kind: "home" }
  | { kind: "device"; devPath: string; title: string }
  | { kind: "help" };
```

- `const [view, setView] = useState<View>({ kind: "home" });` replaces `activeScreen`.
- Delete `NAV_ITEMS` and the 1–4 shortcut `useEffect` (App.tsx:133–147).
- Content switch:

```tsx
{view.kind === "home" && (
  connected === false ? (
    <div className="home-shell__recovery"><SetupCheck /></div>
  ) : (
    <>
      <HomeScreen
        model={configModel}
        connected={connected}
        onOpenDevice={(d) =>
          setView({ kind: "device", devPath: d.nodes[0].path, title: d.name })
        }
      />
      <button className="home-shell__help-link" onClick={() => setView({ kind: "help" })}>
        Help & troubleshooting
      </button>
    </>
  )
)}
{view.kind === "device" && (
  <MappingsScreen
    railActiveProfile={activeProfile}
    onProfilesChange={handleProfilesChange}
    focusDevicePath={view.devPath}
  />
)}
{view.kind === "help" && <StatusScreen />}  {/* Task 7 replaces with <HelpScreen /> */}
```

- Rail: render the rail column ONLY when `view.kind === "device"`; replace the nav-buttons block (App.tsx:184–196) with:

```tsx
<button className="rail__back" onClick={() => setView({ kind: "home" })}>
  ‹ Your devices
</button>
<div className="rail__device-title">{view.title}</div>
```

The profiles section below (App.tsx:198–240) stays byte-identical. The grid: when no rail renders, the app container gets class `app--no-rail` (CSS: `grid-template-columns: 1fr`).
- Delete the status bar JSX (App.tsx:307–337) and the `daemonOk` variable (App.tsx:170–173).
- `SetupCheck` import moves from Status.tsx usage into App.tsx as well (Status.tsx keeps its own).
- Help link/back from help: at the top of the help view render the same `rail__back`-style button inline (`home-shell__back`) that returns to `{ kind: "home" }` — put it inside the `view.kind === "help"` branch above `<StatusScreen />`:

```tsx
{view.kind === "help" && (
  <div className="home-shell__help">
    <button className="home-shell__back" onClick={() => setView({ kind: "home" })}>‹ Your devices</button>
    <StatusScreen />
  </div>
)}
```

Mappings.tsx: add to Props `focusDevicePath?: string;` and after the device list loads (the effect at Mappings.tsx:46–50 that sets `devices`), apply once:

```tsx
useEffect(() => {
  if (!focusDevicePath) return;
  if (devices.some((d) => d.path === focusDevicePath)) {
    setActiveDevPath(focusDevicePath);
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [devices, focusDevicePath]);
```

CSS append:

```css
/* ── Shell: home-first navigation ────────────────────────────────────── */
.app--no-rail { grid-template-columns: 1fr; }
.rail__back { display: block; width: 100%; text-align: left; padding: 8px 10px; margin-bottom: 4px; background: none; border: none; border-radius: var(--r4); color: var(--text-mid); font: inherit; font-size: 13px; cursor: pointer; }
.rail__back:hover { background: var(--bg-key); color: var(--text-hi); }
.rail__device-title { padding: 2px 10px 10px; font-size: 13px; font-weight: 650; color: var(--text-hi); border-bottom: 1px solid var(--border-structural); margin-bottom: 8px; }
.home-shell__help-link { margin: 0 48px 24px; align-self: flex-start; background: none; border: none; color: var(--text-lo); font: inherit; font-size: 12.5px; cursor: pointer; border-bottom: 1px dotted var(--text-dim); padding: 0; }
.home-shell__help-link:hover { color: var(--text-mid); }
.home-shell__back { background: none; border: none; color: var(--text-mid); font: inherit; font-size: 13px; cursor: pointer; padding: 12px 16px; text-align: left; }
.home-shell__help { display: flex; flex-direction: column; overflow-y: auto; }
.home-shell__recovery { display: flex; align-items: center; justify-content: center; height: 100%; }
```

- [ ] **Step 4: Run the suite**

Run: `cd ui && npx vitest run && npx tsc --noEmit`
Expected: PASS — including all pre-existing Mappings tests (the new prop is optional) and updated App tests. Delete any App.test.tsx tests that asserted the removed status bar/nav; note each deletion in the commit message body.

- [ ] **Step 5: Commit**

```bash
git add ui/src/App.tsx ui/src/App.test.tsx ui/src/screens/Mappings.tsx ui/src/App.css
git commit -m "feat(ui): home-first shell — View navigation, no status bar, no daemon dot"
```

---

### Task 6: Pause Conduit — titlebar control + paused banner

**Files:**
- Modify: `ui/src/components/Titlebar.tsx` (remove `connected` prop + dot :27–41; add pause control)
- Modify: `ui/src/components/Toolbar.tsx` (remove suspend/resume button :51–67 + :88–95 and its state)
- Modify: `ui/src/App.tsx` (Titlebar usage :179; render paused banner; track `suspended` from existing `status` state)
- Modify: `ui/src/App.test.tsx`, `ui/src/App.css`

**Interfaces:**
- Consumes: `suspend()`, `resume()`, `getStatus()`, `onStatus()`, `onConnection()` from `../lib/client` (all Phase 1-typed).
- Produces:
  - `Titlebar` props become `{ }` (none) — it tracks `suspended`/`connected` internally exactly the way Toolbar does today (seed from `getStatus()`, then `onStatus`/`onConnection`; that code moves over).
  - Pause button: label "Pause Conduit" when running, "Resume" when paused; class `titlebar__pause`; disabled when disconnected; never shows the word "daemon" (tooltips: "Pause Conduit — your buttons go back to their normal behavior" / "Resume Conduit").
  - App renders `<div className="pause-banner" role="status">` between titlebar and content when `status?.suspended === true`: text "Conduit is paused — your buttons have their normal behavior." plus a "Resume" button calling `resume()`.
  - `Toolbar` keeps `{ title, sub?, children? }` and loses all suspend machinery.

- [ ] **Step 1: Write the failing tests** (App.test.tsx additions)

```tsx
it("shows the pause control and no connection dot in the titlebar", async () => {
  render(<App />);
  expect(await screen.findByRole("button", { name: /Pause Conduit/ })).toBeInTheDocument();
  expect(document.querySelector(".titlebar__daemon")).toBeNull();
});

it("shows an unmissable banner when paused", async () => {
  mockGetStatus.mockResolvedValue({ ...sampleStatus, suspended: true });
  render(<App />);
  expect(await screen.findByRole("status")).toHaveTextContent(
    "Conduit is paused — your buttons have their normal behavior.",
  );
});
```

(`mockGetStatus`/`sampleStatus` already exist in App.test.tsx's client mock; extend as needed.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/App.test.tsx`
Expected: FAIL — no pause button, banner absent.

- [ ] **Step 3: Implement**

Titlebar: delete the `Props` interface and dot span (Titlebar.tsx:27–41); move Toolbar's `suspended`/`connected` state + listeners (Toolbar.tsx:19–43) and handlers (:51–67) into Titlebar; render before the window controls:

```tsx
<button
  className="titlebar__pause"
  disabled={connected === false}
  title={suspended ? "Resume Conduit" : "Pause Conduit — your buttons go back to their normal behavior"}
  onClick={suspended ? handleResume : handlePause}
>
  {suspended ? "Resume" : "Pause Conduit"}
</button>
```

Toolbar: remove the button, state, listeners, and now-unused imports; keep title/sub/children rendering.

App.tsx: `<Titlebar />` (no prop); under the titlebar:

```tsx
{status?.suspended === true && (
  <div className="pause-banner" role="status">
    <span>Conduit is paused — your buttons have their normal behavior.</span>
    <button className="btn" onClick={() => resume().catch(() => {})}>Resume</button>
  </div>
)}
```

(Grid rows: the banner sits inside the main row's flow — wrap main content in a column flex container rather than adding a grid row, whichever is the smaller diff.)

CSS append:

```css
/* ── Pause control + banner ──────────────────────────────────────────── */
.titlebar__pause { background: none; border: 1px solid transparent; border-radius: var(--r4); padding: 3px 10px; font: inherit; font-size: 12px; color: var(--text-mid); cursor: pointer; }
.titlebar__pause:hover { border-color: var(--border-control); background: var(--bg-key); }
.titlebar__pause:disabled { opacity: .5; cursor: default; }
.pause-banner { display: flex; align-items: center; gap: 14px; justify-content: center; padding: 8px 16px; background: var(--amber-border); color: var(--text-hi); font-size: 13px; }
```

- [ ] **Step 4: Run the suite**

Run: `cd ui && npx vitest run && npx tsc --noEmit`
Expected: PASS. Any old Toolbar suspend tests are updated/removed (note in commit body).

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/Titlebar.tsx ui/src/components/Toolbar.tsx ui/src/App.tsx ui/src/App.test.tsx ui/src/App.css
git commit -m "feat(ui): Pause Conduit in titlebar with unmissable paused banner"
```

---

### Task 7: Help screen + end-of-phase verification

**Files:**
- Create: `ui/src/screens/Help.tsx`
- Test: `ui/src/screens/Help.test.tsx`
- Modify: `ui/src/App.tsx` (swap the help-view stand-in for `<HelpScreen />`)
- Modify: `ui/src/App.css`

**Interfaces:**
- Consumes: `KeyTesterScreen`, `StatusScreen`, `DevicesScreen` (all existing, prop-less).
- Produces: `HelpScreen()` — internal tabs `"tester" | "engine" | "hardware"` (default `"tester"`), framed as diagnosis: tab labels "Is Conduit seeing your presses?", "Engine details", "All hardware".

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HelpScreen } from "./Help";

vi.mock("../lib/client", () => ({
  getStatus: vi.fn().mockResolvedValue({
    active_profile: "default", active_layers: [], suspended: false,
    focus: null, grabbed_devices: [], version: "0.1.0", config_version: 0,
  }),
  getConfig: vi.fn().mockResolvedValue(""),
  listDevices: vi.fn().mockResolvedValue([]),
  onStatus: vi.fn().mockResolvedValue(() => {}),
  onConnection: vi.fn().mockResolvedValue([() => {}, () => {}]),
  onKeyEvent: vi.fn().mockResolvedValue(() => {}),
  checkSetup: vi.fn().mockResolvedValue({ daemon: true, uinput: true, input_group: true, config_ok: true }),
}));

describe("HelpScreen", () => {
  it("defaults to the key tester framing and switches tabs", async () => {
    render(<HelpScreen />);
    expect(screen.getByRole("tab", { name: "Is Conduit seeing your presses?", selected: true })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "All hardware" }));
    expect(screen.getByRole("tab", { name: "All hardware", selected: true })).toBeInTheDocument();
  });
});
```

(If the existing screens' client usage needs more mocked functions, extend the mock — keep every function it lists.)

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/screens/Help.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```tsx
import { useState } from "react";
import { DevicesScreen } from "./Devices";
import { KeyTesterScreen } from "./KeyTester";
import { StatusScreen } from "./Status";

type Tab = "tester" | "engine" | "hardware";

const TABS: { id: Tab; label: string }[] = [
  { id: "tester", label: "Is Conduit seeing your presses?" },
  { id: "engine", label: "Engine details" },
  { id: "hardware", label: "All hardware" },
];

export function HelpScreen() {
  const [tab, setTab] = useState<Tab>("tester");
  return (
    <div className="help">
      <div className="help__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={`help__tab${tab === t.id ? " help__tab--sel" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="help__body">
        {tab === "tester" && <KeyTesterScreen />}
        {tab === "engine" && <StatusScreen />}
        {tab === "hardware" && <DevicesScreen />}
      </div>
    </div>
  );
}
```

App.tsx: replace the help-view `<StatusScreen />` stand-in with `<HelpScreen />` (import it; the back button stays).

CSS append:

```css
/* ── Help screen ─────────────────────────────────────────────────────── */
.help { display: flex; flex-direction: column; min-height: 0; }
.help__tabs { display: flex; gap: 4px; padding: 8px 16px 0; border-bottom: 1px solid var(--border-structural); }
.help__tab { background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 12px; font: inherit; font-size: 13px; color: var(--text-lo); cursor: pointer; }
.help__tab--sel { color: var(--text-hi); border-bottom-color: var(--teal); }
.help__body { flex: 1; overflow-y: auto; min-height: 0; }
```

- [ ] **Step 4: Full phase verification**

Run: `export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig && cargo test -p conduit-daemon && cd ui && npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 5: Manual smoke via the running app** (coordinator does this at review time; implementer just commits)

```bash
git add ui/src/screens/Help.tsx ui/src/screens/Help.test.tsx ui/src/App.tsx ui/src/App.css
git commit -m "feat(ui): help & troubleshooting screen; phase 2 complete"
```

---

## Out of scope (later phases)

- Per-card "Control this device" grab toggle (Phase 3, with the editor rework — the hardware table under Help keeps grabs working meanwhile).
- Real recovery/setup screen with fix buttons (Phase 5; `SetupCheck` centered is the interim).
- Mockup palette/typography/motion (Phase 6 polish; Phase 6 also revisits keyboard shortcuts).
- App pills / per-app overlay (Phase 4).
- The InspectorPanel live-TOML footer stays where it is — moving it behind "Advanced" happens with the assignment-panel rework (Phase 3).
