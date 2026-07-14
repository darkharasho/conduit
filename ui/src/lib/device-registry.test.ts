import { describe, expect, it } from "vitest";
import type { DeviceInfo } from "./client";
import { parseConfigToml } from "./config-model";
import {
  appCountForDevice,
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
  it("F2: primaryPath is the path of the first input-class node even when earlier nodes are class 'other'", () => {
    // First node is class "other", second is class "mouse" → primaryPath must be the mouse node's path
    const devices = [
      node({ vendor: 0x046d, product: 0x4099, class: "other", path: "/dev/input/event0", name: "G502 X" }),
      node({ vendor: 0x046d, product: 0x4099, class: "mouse", path: "/dev/input/event1", name: "G502 X" }),
    ];
    const phys = groupPhysicalDevices(devices);
    expect(phys).toHaveLength(1);
    expect(phys[0].primaryPath).toBe("/dev/input/event1");
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
  it("F3: bare vid:pid selector with no curated entry renders as 'Remembered device', never raw hex", () => {
    const hexModel = parseConfigToml(`
[profile.default.device."1234:abcd".keys]
mouse4 = "copy"
`);
    const rem = rememberedDevices(hexModel, []);
    expect(rem).toHaveLength(1);
    expect(rem[0].name).toBe("Remembered device");
    expect(rem[0].name).not.toContain("1234");
  });
});

describe("phase 6 nits", () => {
  it("item 9: appCountForDevice counts non-default profiles with base keys or device section for phys", () => {
    const model = parseConfigToml(`
[profile.default.keys]
capslock = "esc"

[profile.firefox]
match = { class = "firefox" }
[profile.firefox.keys]
f1 = "back"

[profile.steam]
match = { class = "steam" }
[profile.steam.keys]

[profile.default.device."046d:c24a/G600".keys]
mouse4 = "copy"
`);
    const g502 = groupPhysicalDevices([
      node({ vendor: 0x046d, product: 0x4099, class: "mouse", name: "G502 X", path: "/dev/input/event0" }),
    ])[0];

    // firefox has 1 base key → counts; steam has 0 base keys and no device section → doesn't count
    expect(appCountForDevice(model, g502)).toBe(1);
  });

  it("item 9: appCountForDevice counts profiles with a device section matching phys", () => {
    const model = parseConfigToml(`
[profile.default.keys]

[profile.gaming]
match = { class = "steam" }
[profile.gaming.keys]

[profile.gaming.device."046d:c24a/G600".keys]
mouse4 = "macro1"
`);
    const g600 = groupPhysicalDevices([
      node({ vendor: 0x046d, product: 0xc24a, class: "mouse", name: "G600", id: "046d:c24a/G600", path: "/dev/input/event0" }),
    ])[0];

    // gaming has no base keys but has device section matching g600
    expect(appCountForDevice(model, g600)).toBe(1);
  });

  it("item 10: uncurated selector with 'keyboard' in name gets archetype 'keyboard'", () => {
    const result = resolveDevice(0x9999, 0xaaaa, "Acme Wireless Keyboard", "mouse");
    expect(result.archetype).toBe("keyboard");
  });

  it("item 10: uncurated selector without 'keyboard' in name keeps mouse archetype", () => {
    const result = resolveDevice(0x9999, 0xbbbb, "Acme Gaming Mouse", "mouse");
    expect(result.archetype).toBe("mouse");
  });

  it("item 10: 'keyboard' match is case-insensitive", () => {
    expect(resolveDevice(0x9999, 0xcccc, "KEYBOARD Pro", "mouse").archetype).toBe("keyboard");
    expect(resolveDevice(0x9999, 0xdddd, "USB KeyBoard", "touchpad").archetype).toBe("keyboard");
  });
});
