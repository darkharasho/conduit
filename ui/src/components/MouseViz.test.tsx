import { describe, expect, it, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MouseViz } from "./MouseViz";
import { parseConfigToml } from "../lib/config-model";

const dev = { name: "G600", vendor: 0x046d, product: 0xc24a, phys: "", id: "046d:c24a/G600" };
const TOML = `
[profile.default.keys]
wheelup = "volumeup"

[profile.default.device."046d:c24a/G600".keys]
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
