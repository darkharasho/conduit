import type { BatteryInfo } from "./client";

/**
 * Short display label for a battery: "27%", "27% ⚡" while charging, "Full".
 * Returns null when there is nothing meaningful to show (no reported level).
 */
export function formatBattery(b: BatteryInfo): string | null {
  if (b.status === "full") return "Full";
  if (b.percentage === null || b.percentage === undefined) return null;
  return b.charging ? `${b.percentage}% ⚡` : `${b.percentage}%`;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Match a sysfs battery to a device card by name. The kernel reports the
 * model (`G502 X PLUS`) while evdev reports the full name
 * (`Logitech G502 X PLUS`), so match on normalized substring in either
 * direction across the card name and all of its node names.
 */
export function batteryForDevice(
  batteries: BatteryInfo[],
  phys: { name: string; nodes: Array<{ name: string }> },
): BatteryInfo | null {
  const targets = [phys.name, ...phys.nodes.map((n) => n.name)]
    .map(normalize)
    .filter(Boolean);
  for (const b of batteries) {
    const bn = normalize(b.name);
    if (!bn) continue;
    if (targets.some((t) => t.includes(bn) || bn.includes(t))) return b;
  }
  return null;
}
