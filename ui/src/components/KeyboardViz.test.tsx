import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { KeyboardViz } from "./KeyboardViz";
import { parseConfigToml } from "../lib/config-model";

const model = parseConfigToml('[profile.default.keys]\na = "b"');

describe("KeyboardViz capability filtering", () => {
  it("dims board keys the device does not declare and lists extras", () => {
    // Device declares only a (30), s (31), and two off-board codes:
    // volumeup (115, has a name) and 0x2c0 (704, key:N fallback).
    const dev = {
      name: "Weird Kbd",
      vendor: 1,
      product: 2,
      keys: [30, 31, 115, 704],
    };
    const { container } = render(
      <KeyboardViz
        model={model}
        activeProfile="default"
        activeLayer="base"
        selectedKey={null}
        onSelectKey={() => {}}
        dev={dev}
      />
    );
    const capA = container.querySelector('button[title="a"]')!;
    expect(capA.className).not.toContain("keycap--absent");
    const capQ = container.querySelector('button[title="q"]')!;
    expect(capQ.className).toContain("keycap--absent");
    // extras strip: named + key:N chips, both mappable
    expect(container.querySelector('[data-key="volumeup"]')).not.toBeNull();
    expect(container.querySelector('[data-key="key:704"]')).not.toBeNull();
    expect(container.textContent).toContain("Also on this device (2)");
  });

  it("no capability data → nothing dimmed, no extras strip", () => {
    const { container } = render(
      <KeyboardViz
        model={model}
        activeProfile="default"
        activeLayer="base"
        selectedKey={null}
        onSelectKey={() => {}}
        dev={null}
      />
    );
    expect(container.querySelector(".keycap--absent")).toBeNull();
    expect(container.textContent).not.toContain("Also on this device");
  });
});
