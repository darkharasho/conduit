import { describe, expect, it } from "vitest";
import type { BatteryInfo } from "./client";
import { batteryForDevice, formatBattery } from "./battery";

function bat(over: Partial<BatteryInfo>): BatteryInfo {
  return {
    name: "G502 X PLUS",
    percentage: 27,
    status: "discharging",
    charging: false,
    serial: "04-f9-ab-51",
    ...over,
  };
}

describe("formatBattery", () => {
  it("shows a plain percentage while discharging", () => {
    expect(formatBattery(bat({}))).toBe("27%");
  });

  it("adds a bolt while charging", () => {
    expect(formatBattery(bat({ status: "charging", charging: true }))).toBe("27% ⚡");
  });

  it("shows Full when full, even without a percentage", () => {
    expect(formatBattery(bat({ status: "full", percentage: 100 }))).toBe("Full");
    expect(formatBattery(bat({ status: "full", percentage: null }))).toBe("Full");
  });

  it("returns null when no level is reported", () => {
    expect(formatBattery(bat({ percentage: null }))).toBeNull();
  });
});

describe("batteryForDevice", () => {
  const g502x = {
    name: "Logitech G502 X",
    nodes: [{ name: "Logitech G502 X PLUS" }],
  };
  const g600 = {
    name: "Logitech G600",
    nodes: [
      { name: "Logitech Gaming Mouse G600" },
      { name: "Logitech Gaming Mouse G600 Keyboard" },
    ],
  };

  it("matches the kernel model name against an evdev node name", () => {
    const b = bat({});
    expect(batteryForDevice([b], g502x)).toBe(b);
  });

  it("does not match a wired device", () => {
    expect(batteryForDevice([bat({})], g600)).toBeNull();
  });

  it("matches when the battery name contains the card name", () => {
    const b = bat({ name: "Logitech MX Master 3S Wireless Mouse" });
    const card = { name: "Logitech MX Master 3S", nodes: [] };
    expect(batteryForDevice([b], card)).toBe(b);
  });

  it("picks the right battery among several", () => {
    const mx = bat({ name: "MX Keys" });
    const g502 = bat({ name: "G502 X PLUS" });
    expect(batteryForDevice([mx, g502], g502x)).toBe(g502);
  });

  it("ignores batteries with empty names and empty battery lists", () => {
    expect(batteryForDevice([], g502x)).toBeNull();
    expect(batteryForDevice([bat({ name: "" })], g502x)).toBeNull();
  });
});
