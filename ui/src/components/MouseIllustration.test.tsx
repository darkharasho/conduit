import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MouseIllustration } from "./MouseIllustration";
import { parseConfigToml } from "../lib/config-model";
import "../lib/action-catalog";

const MODEL = parseConfigToml('[profile.default.keys]\nmouse4 = "volumeup"');

function renderIllo(overrides: Partial<Parameters<typeof MouseIllustration>[0]> = {}) {
  const props = {
    model: MODEL,
    activeProfile: "default",
    activeLayer: "base",
    selectedKey: null as string | null,
    onSelectKey: vi.fn(),
    dev: null,
    keys: ["btn_left", "btn_right", "btn_middle", "mouse4", "mouse5"],
    ...overrides,
  };
  const utils = render(<MouseIllustration {...props} />);
  return { ...utils, props };
}

describe("MouseIllustration", () => {
  it("draws a clickable marker for each available control", () => {
    const { container } = renderIllo();
    for (const key of ["btn_left", "btn_right", "btn_middle", "mouse4", "mouse5"]) {
      expect(container.querySelector(`[data-illo-key="${key}"]`)).not.toBeNull();
    }
  });

  it("omits markers for controls the device does not have", () => {
    const { container } = renderIllo({ keys: ["btn_left", "btn_right"] });
    expect(container.querySelector('[data-illo-key="mouse4"]')).toBeNull();
  });

  it("clicking a marker selects the key", () => {
    const { container, props } = renderIllo();
    fireEvent.click(container.querySelector('[data-illo-key="mouse4"]')!);
    expect(props.onSelectKey).toHaveBeenCalledWith("mouse4");
  });

  it("the selected control gets a callout with its plain name and job", () => {
    const { container } = renderIllo({ selectedKey: "mouse4" });
    expect(container.textContent).toContain("Back button");
    expect(container.textContent).toContain("Volume up");
  });

  it("customized controls are marked so they stand out on the picture", () => {
    const { container } = renderIllo();
    const mapped = container.querySelector('[data-illo-key="mouse4"]');
    const unmapped = container.querySelector('[data-illo-key="btn_left"]');
    expect(mapped?.getAttribute("class")).toContain("illo__marker--mapped");
    expect(unmapped?.getAttribute("class")).not.toContain("illo__marker--mapped");
  });

  it("shows an always-on job label for mapped controls", () => {
    const model = parseConfigToml('[profile.default.keys]\nmouse4 = "leftctrl+c"');
    renderIllo({ model });
    expect(screen.getByText("Copy")).toBeInTheDocument();
  });
});
