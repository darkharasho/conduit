import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ExtraKeys } from "./ExtraKeys";
import { parseConfigToml } from "../lib/config-model";

// volumeup = evdev code 115
const VOLUMEUP_CODE = 115;

describe("ExtraKeys overlay-aware classes", () => {
  it("chip mapped under default profile shows mousekey--inherited in overlay mode, not mousekey--devspec", () => {
    const TOML = `
[profile.default.keys]
volumeup = "volumeup"

[profile.firefox]
`;
    const model = parseConfigToml(TOML);
    const dev = {
      name: "Test Mouse",
      vendor: 0xdead,
      product: 0xbeef,
      phys: "",
      id: "dead:beef/Test Mouse",
    };

    const { container } = render(
      <ExtraKeys
        model={model}
        activeProfile="firefox"
        activeLayer="base"
        selectedKey={null}
        onSelectKey={() => {}}
        dev={dev}
        codes={[VOLUMEUP_CODE]}
        primary={() => true}
      />
    );

    const chip = container.querySelector('[data-key="volumeup"]')!;
    expect(chip).not.toBeNull();
    expect(chip.className).toContain("mousekey--inherited");
    expect(chip.className).not.toContain("mousekey--devspec");
  });

  it("chip mapped under default profile in default mode shows mousekey--devspec when device-specific", () => {
    const TOML = `
[profile.default.device."dead:beef/Test Mouse".keys]
volumeup = "volumeup"
`;
    const model = parseConfigToml(TOML);
    const dev = {
      name: "Test Mouse",
      vendor: 0xdead,
      product: 0xbeef,
      phys: "",
      id: "dead:beef/Test Mouse",
    };

    const { container } = render(
      <ExtraKeys
        model={model}
        activeProfile="default"
        activeLayer="base"
        selectedKey={null}
        onSelectKey={() => {}}
        dev={dev}
        codes={[VOLUMEUP_CODE]}
        primary={() => true}
      />
    );

    const chip = container.querySelector('[data-key="volumeup"]')!;
    expect(chip).not.toBeNull();
    expect(chip.className).toContain("mousekey--devspec");
    expect(chip.className).not.toContain("mousekey--inherited");
  });
});
