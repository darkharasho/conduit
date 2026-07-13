import { describe, it, expect } from "vitest";
import { actionLabel, keyDisplayName, QUICK_PICKS } from "./action-labels";
import { codeForKeyName } from "./keyboard-layout";

describe("keyDisplayName", () => {
  it("names mouse controls the way a user sees them", () => {
    expect(keyDisplayName("btn_left")).toBe("Left click");
    expect(keyDisplayName("btn_right")).toBe("Right click");
    expect(keyDisplayName("btn_middle")).toBe("Middle click");
    expect(keyDisplayName("mouse4")).toBe("Back button");
    expect(keyDisplayName("mouse5")).toBe("Forward button");
    expect(keyDisplayName("wheelup")).toBe("Scroll up");
  });

  it("names keyboard keys as '<Label> key'", () => {
    expect(keyDisplayName("q")).toBe("Q key");
    expect(keyDisplayName("capslock")).toBe("Caps Lock key");
  });

  it("falls back to raw code names without inventing labels", () => {
    expect(keyDisplayName("key:704")).toBe("Extra button (704)");
  });
});

describe("actionLabel", () => {
  it("says 'Normal job' when unmapped or passthrough", () => {
    expect(actionLabel(null)).toBe("Normal job");
    expect(actionLabel({ kind: "passthrough" })).toBe("Normal job");
  });

  it("says 'Does nothing' when disabled", () => {
    expect(actionLabel({ kind: "disabled" })).toBe("Does nothing");
  });

  it("names action-like keys as the action itself", () => {
    expect(actionLabel({ kind: "key", key: "volumeup" })).toBe("Volume up");
    expect(actionLabel({ kind: "key", key: "back" })).toBe("Back");
    expect(actionLabel({ kind: "key", key: "print" })).toBe("Screenshot");
  });

  it("names character keys as what they type", () => {
    expect(actionLabel({ kind: "key", key: "q" })).toBe("Types Q");
    expect(actionLabel({ kind: "key", key: "enter" })).toBe("Types Enter");
  });

  it("describes tap-hold in a sentence", () => {
    expect(
      actionLabel({ kind: "taphold", tap: "esc", hold: "leftctrl" })
    ).toBe("Esc when tapped, Ctrl when held");
    expect(
      actionLabel({ kind: "taphold", tap: "space", hold: "layer:nav" })
    ).toBe("Space when tapped, nav layer while held");
  });

  it("describes layer toggles", () => {
    expect(actionLabel({ kind: "layer_toggle", layer: "nav" })).toBe(
      "Switches the nav layer on/off"
    );
  });
});

describe("QUICK_PICKS", () => {
  it("every quick pick maps to a key the daemon knows", () => {
    for (const pick of QUICK_PICKS) {
      expect(
        codeForKeyName(pick.key),
        `quick pick "${pick.label}" (${pick.key}) has no evdev code`
      ).not.toBeNull();
    }
  });

  it("offers the media and navigation basics", () => {
    const labels = QUICK_PICKS.map((p) => p.label);
    expect(labels).toContain("Back");
    expect(labels).toContain("Play / Pause");
    expect(labels).toContain("Mute");
    expect(labels).toContain("Screenshot");
  });
});
