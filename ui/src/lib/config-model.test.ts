import { describe, it, expect } from "vitest";
import {
  parseConfigToml,
  serializeConfigToml,
  getAction,
  setAction,
  listProfiles,
  listLayers,
  addProfile,
  addLayer,
  getDeviceGrabs,
  setKeyboardGrab,
  setMouseGrab,
} from "./config-model";

// The spec example TOML from crates/conduit-core/src/config.rs tests.
const SPEC_TOML = `
[settings]
tap_hold_timeout = 200
panic_chord = ["leftctrl", "leftalt", "backspace"]

[devices]
grab_all_keyboards = true
grab_mice = ["Logitech G502"]

[profile.default.keys]
capslock = { tap = "esc", hold = "leftctrl" }
f = { tap = "f", hold = "layer:nav" }

[profile.default.layers.nav]
h = "left"
j = "down"
k = "up"
l = "right"

[profile.firefox]
match = { class = "firefox" }
inherit = "default"
keys = { mouse4 = "back" }
`;

describe("parseConfigToml + getAction", () => {
  it("round-trips the spec example toml preserving profiles", () => {
    const m = parseConfigToml(SPEC_TOML);

    // Profiles present
    expect(listProfiles(m)).toContain("default");
    expect(listProfiles(m)).toContain("firefox");

    // capslock = tap-hold
    const capslockAction = getAction(m, "default", "base", "capslock");
    expect(capslockAction).toEqual({
      kind: "taphold",
      tap: "esc",
      hold: "leftctrl",
    });

    // Nav layer h = left
    const hAction = getAction(m, "default", "nav", "h");
    expect(hAction).toEqual({ kind: "key", key: "left" });

    // Firefox profile has mouse4 = back
    const mouse4Action = getAction(m, "firefox", "base", "mouse4");
    expect(mouse4Action).toEqual({ kind: "key", key: "back" });

    // Firefox inherit field
    const ffProf = m.profiles.find((p) => p.name === "firefox");
    expect(ffProf?.inherit).toBe("default");

    // Round-trip
    const out = serializeConfigToml(m);
    const m2 = parseConfigToml(out);
    expect(listProfiles(m2)).toEqual(listProfiles(m));
    expect(getAction(m2, "default", "base", "capslock")).toEqual(capslockAction);
    expect(getAction(m2, "default", "nav", "h")).toEqual(hAction);
    expect(getAction(m2, "firefox", "base", "mouse4")).toEqual(mouse4Action);
  });

  it("listLayers returns base + named layers", () => {
    const m = parseConfigToml(SPEC_TOML);
    const layers = listLayers(m, "default");
    expect(layers).toContain("base");
    expect(layers).toContain("nav");
    expect(layers[0]).toBe("base");
  });

  it("getAction returns null for unmapped key", () => {
    const m = parseConfigToml(SPEC_TOML);
    expect(getAction(m, "default", "base", "a")).toBeNull();
  });

  it("getAction on inherited profile does NOT auto-resolve inheritance", () => {
    // Firefox inherits default but getAction only looks at firefox's own keys
    const m = parseConfigToml(SPEC_TOML);
    // capslock is defined in default, not in firefox
    const firefoxCapslock = getAction(m, "firefox", "base", "capslock");
    expect(firefoxCapslock).toBeNull();
  });
});

describe("setAction", () => {
  it("creates layer tables on demand and is immutable", () => {
    const m = parseConfigToml(SPEC_TOML);
    const newAction = { kind: "key" as const, key: "esc" };

    const m2 = setAction(m, "default", "symbols", "a", newAction);

    // New model has the new layer
    const layers = listLayers(m2, "default");
    expect(layers).toContain("symbols");

    // New model has the action
    expect(getAction(m2, "default", "symbols", "a")).toEqual(newAction);

    // Original model is unchanged (immutability)
    expect(listLayers(m, "default")).not.toContain("symbols");
    expect(getAction(m, "default", "symbols", "a")).toBeNull();
  });

  it("sets base layer action", () => {
    const m = parseConfigToml(SPEC_TOML);
    const m2 = setAction(m, "default", "base", "a", { kind: "key", key: "b" });
    expect(getAction(m2, "default", "base", "a")).toEqual({ kind: "key", key: "b" });
    // Original unchanged
    expect(getAction(m, "default", "base", "a")).toBeNull();
  });

  it("overwrites existing action", () => {
    const m = parseConfigToml(SPEC_TOML);
    const m2 = setAction(m, "default", "base", "capslock", {
      kind: "key",
      key: "esc",
    });
    expect(getAction(m2, "default", "base", "capslock")).toEqual({
      kind: "key",
      key: "esc",
    });
  });

  it("handles disabled and passthrough kinds", () => {
    const m = parseConfigToml(SPEC_TOML);
    const m2 = setAction(m, "default", "base", "q", { kind: "disabled" });
    expect(getAction(m2, "default", "base", "q")).toEqual({ kind: "disabled" });

    const m3 = setAction(m, "default", "base", "w", { kind: "passthrough" });
    expect(getAction(m3, "default", "base", "w")).toEqual({ kind: "passthrough" });
  });

  it("handles layer_toggle kind", () => {
    const m = parseConfigToml(SPEC_TOML);
    const m2 = setAction(m, "default", "base", "e", {
      kind: "layer_toggle",
      layer: "nav",
    });
    expect(getAction(m2, "default", "base", "e")).toEqual({
      kind: "layer_toggle",
      layer: "nav",
    });
  });

  it("handles taphold with timeoutMs", () => {
    const m = parseConfigToml(SPEC_TOML);
    const m2 = setAction(m, "default", "base", "s", {
      kind: "taphold",
      tap: "s",
      hold: "leftshift",
      timeoutMs: 150,
    });
    expect(getAction(m2, "default", "base", "s")).toEqual({
      kind: "taphold",
      tap: "s",
      hold: "leftshift",
      timeoutMs: 150,
    });
  });

  it("throws when profile not found", () => {
    const m = parseConfigToml(SPEC_TOML);
    expect(() =>
      setAction(m, "nonexistent", "base", "a", { kind: "key", key: "b" })
    ).toThrow();
  });
});

describe("addProfile", () => {
  it("adds a new profile with match class and inherit", () => {
    const m = parseConfigToml(SPEC_TOML);
    const m2 = addProfile(m, "alacritty", "Alacritty");
    expect(listProfiles(m2)).toContain("alacritty");
    const prof = m2.profiles.find((p) => p.name === "alacritty");
    expect(prof?.match).toEqual({ class: "Alacritty" });
    expect(prof?.inherit).toBe("default");
    // Original unchanged
    expect(listProfiles(m)).not.toContain("alacritty");
  });

  it("ignores duplicate profile name", () => {
    const m = parseConfigToml(SPEC_TOML);
    const m2 = addProfile(m, "default", "SomeClass");
    expect(listProfiles(m2).filter((n) => n === "default")).toHaveLength(1);
  });
});

describe("addLayer", () => {
  it("adds a new layer to an existing profile", () => {
    const m = parseConfigToml(SPEC_TOML);
    const m2 = addLayer(m, "default", "media");
    expect(listLayers(m2, "default")).toContain("media");
    // Original unchanged
    expect(listLayers(m, "default")).not.toContain("media");
  });

  it("ignores duplicate layer name", () => {
    const m = parseConfigToml(SPEC_TOML);
    const m2 = addLayer(m, "default", "nav");
    // Should still only have one "nav"
    expect(listLayers(m2, "default").filter((l) => l === "nav")).toHaveLength(1);
  });

  it("ignores unknown profile", () => {
    const m = parseConfigToml(SPEC_TOML);
    const m2 = addLayer(m, "nonexistent", "test");
    expect(m2).toEqual(m);
  });
});

describe("serializeConfigToml", () => {
  it("produces valid TOML that round-trips", () => {
    const m = parseConfigToml(SPEC_TOML);
    const out = serializeConfigToml(m);
    // Should be parseable
    const m2 = parseConfigToml(out);
    expect(listProfiles(m2)).toEqual(listProfiles(m));
  });

  it("preserves taphold with timeout_ms in round-trip", () => {
    const m = parseConfigToml(SPEC_TOML);
    const m2 = setAction(m, "default", "base", "s", {
      kind: "taphold",
      tap: "s",
      hold: "leftshift",
      timeoutMs: 150,
    });
    const out = serializeConfigToml(m2);
    const m3 = parseConfigToml(out);
    expect(getAction(m3, "default", "base", "s")).toEqual({
      kind: "taphold",
      tap: "s",
      hold: "leftshift",
      timeoutMs: 150,
    });
  });

  it("addLayer with empty table survives round-trip", () => {
    const m = parseConfigToml(SPEC_TOML);
    const m2 = addLayer(m, "default", "nav2");
    // Serialize the model with the empty layer
    const out = serializeConfigToml(m2);
    // Parse it back
    const m3 = parseConfigToml(out);
    // Check if the layer exists
    const layers = listLayers(m3, "default");
    expect(layers).toContain("nav2");
  });
});

// TOML with grab_all_keyboards = true to test conversion
const GRAB_ALL_TOML = `
[settings]
tap_hold_timeout = 200

[devices]
grab_all_keyboards = true
grab_mice = ["Logitech G502"]

[profile.default.keys]
capslock = "esc"
`;

// TOML with explicit keyboard list
const EXPLICIT_KEYBOARDS_TOML = `
[settings]
tap_hold_timeout = 200

[devices]
grab_all_keyboards = false
grab_keyboards = ["kbd-a", "kbd-b"]
grab_mice = ["mouse-x"]

[profile.default.keys]
capslock = "esc"
`;

// TOML with no [devices] section
const NO_DEVICES_TOML = `
[settings]
tap_hold_timeout = 200

[profile.default.keys]
capslock = "esc"
`;

describe("getDeviceGrabs", () => {
  it("reads grab_all_keyboards=true from TOML", () => {
    const m = parseConfigToml(GRAB_ALL_TOML);
    const grabs = getDeviceGrabs(m);
    expect(grabs.grabAllKeyboards).toBe(true);
    expect(grabs.grabKeyboards).toEqual([]);
    expect(grabs.grabMice).toEqual(["Logitech G502"]);
  });

  it("reads explicit grab_keyboards from TOML", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const grabs = getDeviceGrabs(m);
    expect(grabs.grabAllKeyboards).toBe(false);
    expect(grabs.grabKeyboards).toEqual(["kbd-a", "kbd-b"]);
    expect(grabs.grabMice).toEqual(["mouse-x"]);
  });

  it("returns safe defaults when [devices] section is absent", () => {
    const m = parseConfigToml(NO_DEVICES_TOML);
    const grabs = getDeviceGrabs(m);
    expect(grabs.grabAllKeyboards).toBe(false);
    expect(grabs.grabKeyboards).toEqual([]);
    expect(grabs.grabMice).toEqual([]);
  });
});

describe("setKeyboardGrab", () => {
  it("grab_all=false: adds a keyboard to grab_keyboards", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setKeyboardGrab(m, "kbd-c", true, ["kbd-a", "kbd-b"]);
    const grabs = getDeviceGrabs(m2);
    expect(grabs.grabKeyboards).toContain("kbd-c");
    expect(grabs.grabKeyboards).toContain("kbd-a");
    // Original unchanged
    expect(getDeviceGrabs(m).grabKeyboards).toEqual(["kbd-a", "kbd-b"]);
  });

  it("grab_all=false: removes a keyboard from grab_keyboards", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setKeyboardGrab(m, "kbd-a", false, ["kbd-a", "kbd-b"]);
    const grabs = getDeviceGrabs(m2);
    expect(grabs.grabKeyboards).not.toContain("kbd-a");
    expect(grabs.grabKeyboards).toContain("kbd-b");
  });

  it("grab_all=false: add is idempotent", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setKeyboardGrab(m, "kbd-a", true, ["kbd-a", "kbd-b"]);
    const grabs = getDeviceGrabs(m2);
    expect(grabs.grabKeyboards.filter((k) => k === "kbd-a")).toHaveLength(1);
  });

  it("grab_all=false: remove non-existent is idempotent", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setKeyboardGrab(m, "kbd-z", false, ["kbd-a", "kbd-b"]);
    expect(getDeviceGrabs(m2).grabKeyboards).toEqual(["kbd-a", "kbd-b"]);
  });

  it("grab_all=true: toggling OFF converts to explicit list minus the device", () => {
    const m = parseConfigToml(GRAB_ALL_TOML);
    // Currently grabbed keyboards: kbd-a, kbd-b, kbd-c — we toggle kbd-b off
    const currentlyGrabbed = ["kbd-a", "kbd-b", "kbd-c"];
    const m2 = setKeyboardGrab(m, "kbd-b", false, currentlyGrabbed);
    const grabs = getDeviceGrabs(m2);
    expect(grabs.grabAllKeyboards).toBe(false);
    expect(grabs.grabKeyboards).toContain("kbd-a");
    expect(grabs.grabKeyboards).toContain("kbd-c");
    expect(grabs.grabKeyboards).not.toContain("kbd-b");
  });

  it("grab_all=true: toggling ON (adding) when grab_all already true keeps grab_all", () => {
    const m = parseConfigToml(GRAB_ALL_TOML);
    // Adding a device when grab_all is already true should not change grab_all
    const m2 = setKeyboardGrab(m, "kbd-new", true, ["kbd-a"]);
    const grabs = getDeviceGrabs(m2);
    // grab_all stays true (adding to grab_all is a no-op conceptually, but
    // implementation may keep grab_all=true)
    expect(grabs.grabAllKeyboards).toBe(true);
  });

  it("creates [devices] section if absent", () => {
    const m = parseConfigToml(NO_DEVICES_TOML);
    const m2 = setKeyboardGrab(m, "kbd-new", true, []);
    const grabs = getDeviceGrabs(m2);
    expect(grabs.grabKeyboards).toContain("kbd-new");
  });

  it("is immutable — original model unchanged", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    setKeyboardGrab(m, "kbd-a", false, ["kbd-a", "kbd-b"]);
    expect(getDeviceGrabs(m).grabKeyboards).toEqual(["kbd-a", "kbd-b"]);
  });
});

describe("setMouseGrab", () => {
  it("adds a mouse to grab_mice", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setMouseGrab(m, "mouse-y", true);
    const grabs = getDeviceGrabs(m2);
    expect(grabs.grabMice).toContain("mouse-y");
    expect(grabs.grabMice).toContain("mouse-x");
  });

  it("removes a mouse from grab_mice", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setMouseGrab(m, "mouse-x", false);
    expect(getDeviceGrabs(m2).grabMice).not.toContain("mouse-x");
  });

  it("add is idempotent", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setMouseGrab(m, "mouse-x", true);
    expect(getDeviceGrabs(m2).grabMice.filter((n) => n === "mouse-x")).toHaveLength(1);
  });

  it("remove non-existent is idempotent", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setMouseGrab(m, "ghost-mouse", false);
    expect(getDeviceGrabs(m2).grabMice).toEqual(["mouse-x"]);
  });

  it("creates [devices] section if absent", () => {
    const m = parseConfigToml(NO_DEVICES_TOML);
    const m2 = setMouseGrab(m, "mouse-new", true);
    expect(getDeviceGrabs(m2).grabMice).toContain("mouse-new");
  });

  it("is immutable — original model unchanged", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    setMouseGrab(m, "mouse-x", false);
    expect(getDeviceGrabs(m).grabMice).toEqual(["mouse-x"]);
  });
});
