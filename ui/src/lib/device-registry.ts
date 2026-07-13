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
