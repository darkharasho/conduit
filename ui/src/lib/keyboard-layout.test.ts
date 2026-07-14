import { describe, it, expect } from "vitest";
import { ANSI_LAYOUT, VALID_KEY_NAMES } from "./keyboard-layout";

describe("ANSI_LAYOUT", () => {
  it("every keycap name is unique and non-empty", () => {
    const all = ANSI_LAYOUT.flat();
    const names = all.map((k) => k.name);

    // All non-empty
    for (const name of names) {
      expect(name.length, `empty name in layout`).toBeGreaterThan(0);
    }

    // All unique
    const set = new Set(names);
    expect(set.size).toBe(names.length);
  });

  it("every keycap name resolves to a valid daemon key name", () => {
    const all = ANSI_LAYOUT.flat();
    for (const cap of all) {
      expect(
        VALID_KEY_NAMES.has(cap.name),
        `"${cap.name}" is not in VALID_KEY_NAMES (not a valid daemon key)`
      ).toBe(true);
    }
  });

  it("every keycap label is non-empty", () => {
    const all = ANSI_LAYOUT.flat();
    for (const cap of all) {
      expect(cap.label.length, `empty label for key "${cap.name}"`).toBeGreaterThan(0);
    }
  });

  it("every keycap has a positive width", () => {
    const all = ANSI_LAYOUT.flat();
    for (const cap of all) {
      expect(cap.width, `non-positive width for "${cap.name}"`).toBeGreaterThan(0);
    }
  });

  it("main rows sum to 15u ±0.01 (F13-F24 row 1 and mouse row exempt)", () => {
    const F13_F24_ROW_IDX = 1;
    const MOUSE_ROW_IDX = 6;
    ANSI_LAYOUT.forEach((row, idx) => {
      if (idx === F13_F24_ROW_IDX || idx === MOUSE_ROW_IDX) return; // F13-F24 and mouse rows exempt
      const sum = row.reduce((acc, cap) => acc + cap.width, 0);
      expect(
        Math.abs(sum - 15),
        `row ${idx} sums to ${sum}u, expected 15u`
      ).toBeLessThanOrEqual(0.01);
    });
  });
});
