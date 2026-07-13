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
  getProfileMatchLabel,
  actionToTomlLine,
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

const ident = (name: string) => ({ name, vendor: 0, product: 0, id: name });

describe("setKeyboardGrab", () => {
  it("grab_all=false: adds a keyboard to grab_keyboards", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setKeyboardGrab(m, ident("kbd-c"), true, ["kbd-a", "kbd-b"]);
    const grabs = getDeviceGrabs(m2);
    expect(grabs.grabKeyboards).toContain("kbd-c");
    expect(grabs.grabKeyboards).toContain("kbd-a");
    // Original unchanged
    expect(getDeviceGrabs(m).grabKeyboards).toEqual(["kbd-a", "kbd-b"]);
  });

  it("grab_all=false: removes a keyboard from grab_keyboards", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setKeyboardGrab(m, ident("kbd-a"), false, ["kbd-a", "kbd-b"]);
    const grabs = getDeviceGrabs(m2);
    expect(grabs.grabKeyboards).not.toContain("kbd-a");
    expect(grabs.grabKeyboards).toContain("kbd-b");
  });

  it("grab_all=false: add is idempotent", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setKeyboardGrab(m, ident("kbd-a"), true, ["kbd-a", "kbd-b"]);
    const grabs = getDeviceGrabs(m2);
    expect(grabs.grabKeyboards.filter((k) => k === "kbd-a")).toHaveLength(1);
  });

  it("grab_all=false: remove non-existent is idempotent", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setKeyboardGrab(m, ident("kbd-z"), false, ["kbd-a", "kbd-b"]);
    expect(getDeviceGrabs(m2).grabKeyboards).toEqual(["kbd-a", "kbd-b"]);
  });

  it("grab_all=true: toggling OFF converts to explicit list minus the device", () => {
    const m = parseConfigToml(GRAB_ALL_TOML);
    // Currently grabbed keyboards: kbd-a, kbd-b, kbd-c — we toggle kbd-b off
    const currentlyGrabbed = ["kbd-a", "kbd-b", "kbd-c"];
    const m2 = setKeyboardGrab(m, ident("kbd-b"), false, currentlyGrabbed);
    const grabs = getDeviceGrabs(m2);
    expect(grabs.grabAllKeyboards).toBe(false);
    expect(grabs.grabKeyboards).toContain("kbd-a");
    expect(grabs.grabKeyboards).toContain("kbd-c");
    expect(grabs.grabKeyboards).not.toContain("kbd-b");
  });

  it("grab_all=true: toggling ON (adding) when grab_all already true keeps grab_all", () => {
    const m = parseConfigToml(GRAB_ALL_TOML);
    // Adding a device when grab_all is already true should not change grab_all
    const m2 = setKeyboardGrab(m, ident("kbd-new"), true, ["kbd-a"]);
    const grabs = getDeviceGrabs(m2);
    // grab_all stays true (adding to grab_all is a no-op conceptually, but
    // implementation may keep grab_all=true)
    expect(grabs.grabAllKeyboards).toBe(true);
  });

  it("creates [devices] section if absent", () => {
    const m = parseConfigToml(NO_DEVICES_TOML);
    const m2 = setKeyboardGrab(m, ident("kbd-new"), true, []);
    const grabs = getDeviceGrabs(m2);
    expect(grabs.grabKeyboards).toContain("kbd-new");
  });

  it("is immutable — original model unchanged", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    setKeyboardGrab(m, ident("kbd-a"), false, ["kbd-a", "kbd-b"]);
    expect(getDeviceGrabs(m).grabKeyboards).toEqual(["kbd-a", "kbd-b"]);
  });
});

describe("setMouseGrab", () => {
  it("adds a mouse to grab_mice", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setMouseGrab(m, ident("mouse-y"), true);
    const grabs = getDeviceGrabs(m2);
    expect(grabs.grabMice).toContain("mouse-y");
    expect(grabs.grabMice).toContain("mouse-x");
  });

  it("removes a mouse from grab_mice", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setMouseGrab(m, ident("mouse-x"), false);
    expect(getDeviceGrabs(m2).grabMice).not.toContain("mouse-x");
  });

  it("add is idempotent", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setMouseGrab(m, ident("mouse-x"), true);
    expect(getDeviceGrabs(m2).grabMice.filter((n) => n === "mouse-x")).toHaveLength(1);
  });

  it("remove non-existent is idempotent", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    const m2 = setMouseGrab(m, ident("ghost-mouse"), false);
    expect(getDeviceGrabs(m2).grabMice).toEqual(["mouse-x"]);
  });

  it("creates [devices] section if absent", () => {
    const m = parseConfigToml(NO_DEVICES_TOML);
    const m2 = setMouseGrab(m, ident("mouse-new"), true);
    expect(getDeviceGrabs(m2).grabMice).toContain("mouse-new");
  });

  it("is immutable — original model unchanged", () => {
    const m = parseConfigToml(EXPLICIT_KEYBOARDS_TOML);
    setMouseGrab(m, ident("mouse-x"), false);
    expect(getDeviceGrabs(m).grabMice).toEqual(["mouse-x"]);
  });
});

describe("getProfileMatchLabel", () => {
  it("returns null for default profile (no match rule)", () => {
    const m = parseConfigToml(SPEC_TOML);
    expect(getProfileMatchLabel(m, "default")).toBeNull();
  });

  it("returns class:firefox for the firefox profile", () => {
    const m = parseConfigToml(SPEC_TOML);
    expect(getProfileMatchLabel(m, "firefox")).toBe("class:firefox");
  });

  it("returns null for unknown profile", () => {
    const m = parseConfigToml(SPEC_TOML);
    expect(getProfileMatchLabel(m, "nonexistent")).toBeNull();
  });

  it("returns process: when class is absent", () => {
    const toml = `
[profile.default.keys]
a = "b"
[profile.terminal]
match = { process = "alacritty" }
[profile.terminal.keys]
`;
    const m = parseConfigToml(toml);
    expect(getProfileMatchLabel(m, "terminal")).toBe("process:alacritty");
  });
});

describe("actionToTomlLine", () => {
  it("renders key remap on base layer", () => {
    const line = actionToTomlLine("default", "base", "capslock", {
      kind: "key",
      key: "esc",
    });
    expect(line).toBe(`conduit.toml → [profile.default.keys] capslock = "esc"`);
  });

  it("renders taphold on base layer", () => {
    const line = actionToTomlLine("default", "base", "capslock", {
      kind: "taphold",
      tap: "esc",
      hold: "leftctrl",
    });
    expect(line).toBe(
      `conduit.toml → [profile.default.keys] capslock = { tap = "esc", hold = "leftctrl" }`
    );
  });

  it("renders taphold with timeoutMs", () => {
    const line = actionToTomlLine("default", "base", "f", {
      kind: "taphold",
      tap: "f",
      hold: "layer:nav",
      timeoutMs: 150,
    });
    expect(line).toBe(
      `conduit.toml → [profile.default.keys] f = { tap = "f", hold = "layer:nav", timeout_ms = 150 }`
    );
  });

  it("renders layer_toggle on named layer", () => {
    const line = actionToTomlLine("default", "nav", "h", {
      kind: "layer_toggle",
      layer: "media",
    });
    expect(line).toBe(
      `conduit.toml → [profile.default.layers.nav] h = "layer:media"`
    );
  });

  it("renders disabled", () => {
    const line = actionToTomlLine("default", "base", "capslock", {
      kind: "disabled",
    });
    expect(line).toBe(
      `conduit.toml → [profile.default.keys] capslock = "disabled"`
    );
  });

  it("renders passthrough", () => {
    const line = actionToTomlLine("firefox", "base", "mouse4", {
      kind: "passthrough",
    });
    expect(line).toBe(
      `conduit.toml → [profile.firefox.keys] mouse4 = "passthrough"`
    );
  });

  it("uses profile.P.layers.L section for named layer", () => {
    const line = actionToTomlLine("myprofile", "symbols", "a", {
      kind: "key",
      key: "b",
    });
    expect(line).toBe(
      `conduit.toml → [profile.myprofile.layers.symbols] a = "b"`
    );
  });
});

// ── Device selectors + grab_all_mice ─────────────────────────────────────────

import {
  selectorMatches,
  listMatchesDevice,
  setProfileMatch,
} from "./config-model";

const g600 = { name: "G600", vendor: 0x046d, product: 0xc24a };

describe("device selectors", () => {
  it("matches name, vid:pid, and vid:pid/name forms", () => {
    expect(selectorMatches("G600", g600)).toBe(true);
    expect(selectorMatches("046d:c24a", g600)).toBe(true);
    expect(selectorMatches("046d:c24a/G600", g600)).toBe(true);
    expect(selectorMatches("046d:ffff", g600)).toBe(false);
    expect(selectorMatches("046d:c24a/Other", g600)).toBe(false);
    expect(selectorMatches("Other", g600)).toBe(false);
  });

  it("grab_all_mice round-trips and setMouseGrab writes canonical id", () => {
    const m = parseConfigToml("[devices]\ngrab_all_mice = true");
    expect(getDeviceGrabs(m).grabAllMice).toBe(true);

    const m2 = setMouseGrab(parseConfigToml(""), { ...g600, id: "046d:c24a/G600" }, true);
    expect(getDeviceGrabs(m2).grabMice).toEqual(["046d:c24a/G600"]);
    expect(serializeConfigToml(m2)).toContain("046d:c24a/G600");

    // Removal drops any selector form matching the device.
    const m3 = parseConfigToml('[devices]\ngrab_mice = ["G600", "046d:c24a"]');
    const m4 = setMouseGrab(m3, { ...g600, id: "046d:c24a/G600" }, false);
    expect(getDeviceGrabs(m4).grabMice).toEqual([]);
  });

  it("listMatchesDevice", () => {
    expect(listMatchesDevice(["046d:c24a"], g600)).toBe(true);
    expect(listMatchesDevice(["nope"], g600)).toBe(false);
    expect(listMatchesDevice([], g600)).toBe(false);
  });
});

// ── setProfileMatch ──────────────────────────────────────────────────────────

describe("setProfileMatch", () => {
  it("writes, updates, and clears the match table", () => {
    const m = parseConfigToml(
      '[profile.game]\nmatch = { class = "steam" }\n[profile.game.keys]\na = "b"'
    );
    const m2 = setProfileMatch(m, "game", { class: "steam_app_123", title: "Elden" });
    expect(m2.profiles[0].match).toEqual({ class: "steam_app_123", title: "Elden" });
    // empty strings dropped
    const m3 = setProfileMatch(m, "game", { class: "x", process: "" });
    expect(m3.profiles[0].match).toEqual({ class: "x" });
    // all empty → removed
    const m4 = setProfileMatch(m, "game", {});
    expect(m4.profiles[0].match).toBeUndefined();
    expect(serializeConfigToml(m4)).not.toContain("match");
    // unknown profile → unchanged
    expect(setProfileMatch(m, "nope", { class: "x" })).toBe(m);
  });
});

// ── Per-device override sections ─────────────────────────────────────────────

import {
  selectorSpecificity,
  deviceSectionFor,
  deviceSectionKey,
  getEffectiveAction,
  setDeviceAction,
  removeDeviceAction,
} from "./config-model";

const DEV_SECTIONS_TOML = `
[profile.default.keys]
a = "b"

[profile.default.device."046d:c24a/G600".keys]
btn_left = "enter"
`;
const g600full = { name: "G600", vendor: 0x046d, product: 0xc24a, phys: "usb-1", id: "046d:c24a/G600" };

describe("device override sections", () => {
  it("round-trips profile.device through TOML", () => {
    const m = parseConfigToml(DEV_SECTIONS_TOML);
    expect(m.profiles[0].device?.["046d:c24a/G600"].keys["btn_left"]).toBe("enter");
    expect(serializeConfigToml(m)).toContain('"046d:c24a/G600"');
  });

  it("selector @phys and specificity", () => {
    expect(selectorMatches("046d:c24a/G600@usb-1", g600full)).toBe(true);
    expect(selectorMatches("046d:c24a/G600@usb-2", g600full)).toBe(false);
    expect(selectorMatches("Weird@Name", { name: "Weird@Name", vendor: 0, product: 0 })).toBe(true);
    expect(selectorSpecificity("046d:c24a/G600@usb-1")).toBe(4);
    expect(selectorSpecificity("046d:c24a/G600")).toBe(3);
    expect(selectorSpecificity("G600")).toBe(2);
    expect(selectorSpecificity("046d:c24a")).toBe(1);
  });

  it("deviceSectionFor picks most specific, ties → first", () => {
    const m = parseConfigToml(`
[profile.default.device."046d:c24a".keys]
a = "x"
[profile.default.device."046d:c24a/G600".keys]
a = "y"
`);
    expect(deviceSectionFor(m, "default", g600full)).toBe("046d:c24a/G600");
    expect(deviceSectionFor(m, "default", { ...g600full, name: "Other" })).toBe("046d:c24a");
    expect(deviceSectionFor(m, "default", { name: "n", vendor: 1, product: 1 })).toBeNull();
  });

  it("effective action: device shadows profile, falls through otherwise", () => {
    const m = parseConfigToml(DEV_SECTIONS_TOML);
    expect(getEffectiveAction(m, "default", g600full, "base", "btn_left"))
      .toEqual({ action: { kind: "key", key: "enter" }, source: "device" });
    expect(getEffectiveAction(m, "default", g600full, "base", "a"))
      .toEqual({ action: { kind: "key", key: "b" }, source: "profile" });
    expect(getEffectiveAction(m, "default", g600full, "base", "q")).toBeNull();
    // no device context → profile only
    expect(getEffectiveAction(m, "default", null, "base", "btn_left")).toBeNull();
  });

  it("setDeviceAction creates and removeDeviceAction prunes", () => {
    let m = parseConfigToml('[profile.default.keys]\na = "b"');
    m = setDeviceAction(m, "default", "046d:c24a/G600", "base", "mouse4", { kind: "key", key: "back" });
    expect(getEffectiveAction(m, "default", g600full, "base", "mouse4")?.source).toBe("device");
    // layer table
    m = setDeviceAction(m, "default", "046d:c24a/G600", "nav", "h", { kind: "key", key: "home" });
    expect(m.profiles[0].device?.["046d:c24a/G600"].layers["nav"]["h"]).toBe("home");
    m = removeDeviceAction(m, "default", "046d:c24a/G600", "nav", "h");
    m = removeDeviceAction(m, "default", "046d:c24a/G600", "base", "mouse4");
    expect(m.profiles[0].device).toBeUndefined(); // fully pruned
  });

  it("deviceSectionKey appends @phys only for twins", () => {
    const twinA = { ...g600full, phys: "usb-1" };
    const twinB = { ...g600full, phys: "usb-2" };
    expect(deviceSectionKey(twinA, [twinA])).toBe("046d:c24a/G600");
    expect(deviceSectionKey(twinA, [twinA, twinB])).toBe("046d:c24a/G600@usb-1");
  });
});

// ── removeAction ("Use default") ─────────────────────────────────────────────

import { removeAction } from "./config-model";

describe("removeAction", () => {
  it("deletes a base-layer mapping so the key reverts to its normal job", () => {
    let m = parseConfigToml('[profile.default.keys]\nmouse4 = "back"\na = "b"');
    m = removeAction(m, "default", "base", "mouse4");
    expect(getAction(m, "default", "base", "mouse4")).toBeNull();
    // untouched sibling mapping survives
    expect(getAction(m, "default", "base", "a")).toEqual({ kind: "key", key: "b" });
  });

  it("deletes a named-layer mapping and prunes the layer when empty", () => {
    let m = parseConfigToml('[profile.default.keys]\na = "b"\n[profile.default.layers.nav]\nh = "left"');
    m = removeAction(m, "default", "nav", "h");
    expect(getAction(m, "default", "nav", "h")).toBeNull();
    expect(m.profiles[0].layers["nav"]).toBeUndefined();
  });

  it("is a no-op for unknown profile or unmapped key", () => {
    const m = parseConfigToml('[profile.default.keys]\na = "b"');
    expect(removeAction(m, "nope", "base", "a")).toBe(m);
    const same = removeAction(m, "default", "base", "q");
    expect(getAction(same, "default", "base", "a")).toEqual({ kind: "key", key: "b" });
  });

  it("does not mutate the input model", () => {
    const m = parseConfigToml('[profile.default.keys]\nmouse4 = "back"');
    removeAction(m, "default", "base", "mouse4");
    expect(getAction(m, "default", "base", "mouse4")).toEqual({ kind: "key", key: "back" });
  });
});
