import { describe, it, expect } from "vitest";
import { layoutFor } from "./mouse-layouts";

describe("G502X layout", () => {
  const layout = layoutFor({ vendor: 0x046d, product: 0x4099 });

  it("is defined", () => {
    expect(layout).not.toBeNull();
  });

  it("has sideButtons: true", () => {
    expect(layout?.sideButtons).toBe(true);
  });

  it("has zero null-key rows except the profile-cycle button", () => {
    const nullButtons = layout?.groups
      .flatMap((g) => g.buttons)
      .filter((b) => b.key === null) ?? [];
    // Only G9 profile-cycle should remain null-keyed
    expect(nullButtons).toHaveLength(1);
    expect(nullButtons[0].label).toMatch(/G9|profile/i);
  });

  it("exposes f13 through f16 as real keyed buttons", () => {
    const allButtons = layout?.groups.flatMap((g) => g.buttons) ?? [];
    const keys = allButtons.map((b) => b.key).filter(Boolean);
    expect(keys).toContain("f13");
    expect(keys).toContain("f14");
    expect(keys).toContain("f15");
    expect(keys).toContain("f16");
  });

  it("labels f13–f16 with human names not key codes", () => {
    const allButtons = layout?.groups.flatMap((g) => g.buttons) ?? [];
    const fButtons = allButtons.filter(
      (b) => b.key && ["f13", "f14", "f15", "f16"].includes(b.key)
    );
    for (const b of fButtons) {
      // Label must NOT contain raw key code form
      expect(b.label).not.toMatch(/^f1[3-6]$/i);
      // Label must be a human-readable name
      expect(b.label.length).toBeGreaterThan(0);
    }
    // Verify specific labels
    const byKey = Object.fromEntries(fButtons.map((b) => [b.key, b.label]));
    expect(byKey["f14"]).toBe("Side front button");
    expect(byKey["f13"]).toBe("Side rear button");
    expect(byKey["f15"]).toBe("Thumb button");
    expect(byKey["f16"]).toBe("Rear trigger");
  });

  it("wired variant (c099) also has sideButtons and f13–f16", () => {
    const wired = layoutFor({ vendor: 0x046d, product: 0xc099 });
    expect(wired?.sideButtons).toBe(true);
    const keys = wired?.groups.flatMap((g) => g.buttons).map((b) => b.key) ?? [];
    expect(keys).toContain("f13");
    expect(keys).toContain("f16");
  });
});

describe("G600 layout", () => {
  const layout = layoutFor({ vendor: 0x046d, product: 0xc24a });

  it("is defined", () => {
    expect(layout).not.toBeNull();
  });

  it("has sideButtons: true", () => {
    expect(layout?.sideButtons).toBe(true);
  });
});
