import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MouseViz } from "./MouseViz";
import { parseConfigToml } from "../lib/config-model";

const dev = { name: "NoName Mouse", vendor: 0xdead, product: 0xbeef, phys: "", id: "dead:beef/NoName Mouse" };
const TOML = `
[profile.default.keys]
wheelup = "volumeup"

[profile.default.device."dead:beef/NoName Mouse".keys]
btn_left = "enter"
`;

describe("MouseViz", () => {
  it("marks mapped and device-specific controls, selects on click", () => {
    const model = parseConfigToml(TOML);
    const onSelect = vi.fn();
    const { container } = render(
      <MouseViz
        model={model}
        activeProfile="default"
        activeLayer="base"
        selectedKey={null}
        onSelectKey={onSelect}
        dev={dev}
      />
    );
    const m1 = container.querySelector('[data-key="btn_left"]')!;
    expect(m1.className).toContain("mousekey--mapped");
    expect(m1.className).toContain("mousekey--devspec");
    const wheel = container.querySelector('[data-key="wheelup"]')!;
    expect(wheel.className).toContain("mousekey--mapped");
    expect(wheel.className).not.toContain("mousekey--devspec");
    fireEvent.click(m1);
    expect(onSelect).toHaveBeenCalledWith("btn_left");
    // all twelve controls present
    for (const k of [
      "btn_left", "btn_right", "btn_middle", "mouse4", "mouse5",
      "wheelup", "wheeldown", "wheelleft", "wheelright",
      "btn_forward", "btn_back", "btn_task",
    ]) {
      expect(container.querySelector(`[data-key="${k}"]`)).not.toBeNull();
    }
  });

  it("renders only capabilities the device declares", () => {
    const model = parseConfigToml(TOML);
    // 3 buttons + mouse4 only, vertical wheel only, one gaming extra (0x120)
    const capDev = {
      ...dev,
      keys: [0x110, 0x111, 0x112, 0x113, 0x120],
      wheel: true,
      hwheel: false,
    };
    const { container } = render(
      <MouseViz
        model={model}
        activeProfile="default"
        activeLayer="base"
        selectedKey={null}
        onSelectKey={() => {}}
        dev={capDev}
      />
    );
    for (const present of ["btn_left", "btn_right", "btn_middle", "mouse4", "wheelup", "wheeldown"]) {
      expect(container.querySelector(`[data-key="${present}"]`), present).not.toBeNull();
    }
    for (const absent of ["mouse5", "btn_forward", "btn_back", "btn_task", "wheelleft", "wheelright"]) {
      expect(container.querySelector(`[data-key="${absent}"]`), absent).toBeNull();
    }
    // undeclared-by-name code shows as a mappable key:N chip
    expect(container.querySelector('[data-key="key:288"]')).not.toBeNull();
    expect(container.textContent).toContain("Also on this device (1)");
  });

  it("without a device: profile mappings show, no devspec markers", () => {
    const model = parseConfigToml(TOML);
    const { container } = render(
      <MouseViz
        model={model}
        activeProfile="default"
        activeLayer="base"
        selectedKey={null}
        onSelectKey={() => {}}
        dev={null}
      />
    );
    expect(container.querySelector('[data-key="wheelup"]')!.className).toContain("mousekey--mapped");
    expect(container.querySelector(".mousekey--devspec")).toBeNull();
  });
});

describe("MouseViz curated layouts", () => {
  it("G502 X PLUS gets researched labels and onboard chips", () => {
    const model = parseConfigToml("");
    const g502 = {
      name: "Logitech G502 X PLUS", vendor: 0x046d, product: 0x4099,
      phys: "", id: "046d:4099/Logitech G502 X PLUS",
      keys: [0x110, 0x111, 0x112, 0x113, 0x114], wheel: true, hwheel: true,
    };
    const { container, getByText, getByLabelText } = render(
      <MouseViz model={model} activeProfile="default" activeLayer="base"
                selectedKey={null} onSelectKey={() => {}} dev={g502} />
    );
    expect(getByLabelText("Logitech G502 X")).toBeTruthy();
    expect(getByText("G4 · Back")).toBeTruthy();
    expect(getByText("G6 · DPI shift (sniper)")).toBeTruthy();
    // Onboard controls are informational, not buttons.
    const onboard = container.querySelectorAll(".mousekey--onboard");
    expect(onboard.length).toBe(4);
    // Mappable curated chips carry the canonical key.
    expect(container.querySelector('[data-key="mouse4"]')).not.toBeNull();
  });

  it("G600 keyboard node is handled by KeyboardViz, not MouseViz (mouse node here)", () => {
    const model = parseConfigToml("");
    const g600 = {
      name: "Logitech Gaming Mouse G600", vendor: 0x046d, product: 0xc24a,
      phys: "", id: "046d:c24a/Logitech Gaming Mouse G600",
      keys: [0x110, 0x111, 0x112], wheel: true, hwheel: true, class: "mouse",
    };
    const { getByText } = render(
      <MouseViz model={model} activeProfile="default" activeLayer="base"
                selectedKey={null} onSelectKey={() => {}} dev={g600} />
    );
    expect(getByText("G3 · Wheel click")).toBeTruthy();
    expect(getByText("G6 · G-shift (ring finger)")).toBeTruthy();
  });
});
