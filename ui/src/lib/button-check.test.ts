import { describe, it, expect } from "vitest";
import { analyzePresses } from "./button-check";
import type { PressSample } from "./button-check";

describe("analyzePresses", () => {
  describe("empty samples", () => {
    it("empty array returns zeros", () => {
      const result = analyzePresses([], "mouse");
      expect(result.distinct).toBe(0);
      expect(result.presses).toBe(0);
      expect(result.collisions).toEqual([]);
      expect(result.keyboardCodes).toEqual([]);
    });
  });

  describe("no collisions", () => {
    it("[side, extra] → distinct 2, presses 2, no collisions", () => {
      const samples: PressSample[] = [
        { code: 275, keyName: "side" }, // BTN_SIDE
        { code: 276, keyName: "extra" }, // BTN_EXTRA
      ];
      const result = analyzePresses(samples, "mouse");
      expect(result.distinct).toBe(2);
      expect(result.presses).toBe(2);
      expect(result.collisions).toEqual([]);
    });
  });

  describe("consecutive identical samples count as one press", () => {
    it("[left, left] → left count 1, no collision (consecutive duplicates)", () => {
      const samples: PressSample[] = [
        { code: 272, keyName: "left" }, // BTN_LEFT
        { code: 272, keyName: "left" }, // consecutive identical
      ];
      const result = analyzePresses(samples, "mouse");
      expect(result.distinct).toBe(1);
      expect(result.presses).toBe(1); // consecutive identical = held/repeat, counts as one
      expect(result.collisions).toEqual([]);
    });
  });

  describe("collisions: same code re-appearing after different code", () => {
    it("[left, side, left] → left count 2 → collision (two physical buttons emit left)", () => {
      const samples: PressSample[] = [
        { code: 272, keyName: "left" }, // BTN_LEFT
        { code: 275, keyName: "side" }, // BTN_SIDE (different code)
        { code: 272, keyName: "left" }, // BTN_LEFT re-appears → separate press
      ];
      const result = analyzePresses(samples, "mouse");
      expect(result.distinct).toBe(2);
      expect(result.presses).toBe(3);
      expect(result.collisions).toHaveLength(1);
      expect(result.collisions[0]).toMatchObject({
        code: 272,
        keyName: "left",
        count: 2,
      });
    });
  });

  describe("keyboard codes from pointer device", () => {
    it("[esc] on class 'mouse' → keyboardCodes contains esc (code < 0x100)", () => {
      const samples: PressSample[] = [
        { code: 1, keyName: "esc" }, // code 1 < 0x100
      ];
      const result = analyzePresses(samples, "mouse");
      expect(result.keyboardCodes).toHaveLength(1);
      expect(result.keyboardCodes[0]).toMatchObject({
        code: 1,
        keyName: "esc",
      });
    });

    it("keyboard codes only for deviceClass 'mouse' or 'touchpad'", () => {
      const samples: PressSample[] = [
        { code: 1, keyName: "esc" },
      ];
      const resultMouse = analyzePresses(samples, "mouse");
      expect(resultMouse.keyboardCodes).toHaveLength(1);

      const resultTouchpad = analyzePresses(samples, "touchpad");
      expect(resultTouchpad.keyboardCodes).toHaveLength(1);

      const resultKeyboard = analyzePresses(samples, "keyboard");
      expect(resultKeyboard.keyboardCodes).toHaveLength(0);
    });

    it("codes >= 0x100 not included in keyboardCodes", () => {
      const samples: PressSample[] = [
        { code: 1, keyName: "esc" },       // < 0x100
        { code: 272, keyName: "left" },    // >= 0x100 (BTN_LEFT)
      ];
      const result = analyzePresses(samples, "mouse");
      expect(result.keyboardCodes).toHaveLength(1);
      expect(result.keyboardCodes[0].keyName).toBe("esc");
    });
  });

  describe("complex collision scenarios", () => {
    it("multiple physical buttons emitting same code shows all as collisions", () => {
      // Simulate three buttons all emitting "left"
      const samples: PressSample[] = [
        { code: 272, keyName: "left" },   // press 1
        { code: 275, keyName: "side" },   // different code (separator)
        { code: 272, keyName: "left" },   // press 2
        { code: 276, keyName: "extra" },  // different code (separator)
        { code: 272, keyName: "left" },   // press 3
      ];
      const result = analyzePresses(samples, "mouse");
      expect(result.distinct).toBe(3);
      expect(result.presses).toBe(5);
      expect(result.collisions).toHaveLength(1);
      expect(result.collisions[0].count).toBe(3);
    });

    it("[left, left, left, side, left] → left held twice then pressed again", () => {
      const samples: PressSample[] = [
        { code: 272, keyName: "left" },   // press 1 (held)
        { code: 272, keyName: "left" },   // consecutive (same hold)
        { code: 272, keyName: "left" },   // consecutive (same hold)
        { code: 275, keyName: "side" },   // different code (separator)
        { code: 272, keyName: "left" },   // press 2 (separate press)
      ];
      const result = analyzePresses(samples, "mouse");
      expect(result.distinct).toBe(2);
      expect(result.presses).toBe(3); // left-hold(1), side(1), left(1)
      expect(result.collisions).toHaveLength(1);
      expect(result.collisions[0].count).toBe(2);
    });
  });
});
