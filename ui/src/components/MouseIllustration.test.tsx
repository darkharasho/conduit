import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MouseIllustration } from "./MouseIllustration";
import { parseConfigToml } from "../lib/config-model";
import "../lib/action-catalog";
import { layoutFor } from "../lib/mouse-layouts";

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

describe("MouseIllustration — G502X side view", () => {
  const G502X_KEYS = [
    "btn_left", "btn_right", "btn_middle", "mouse4", "mouse5",
    "f13", "f14", "f15", "f16",
  ];

  function renderG502XIllo(
    overrides: Partial<Parameters<typeof MouseIllustration>[0]> = {},
  ) {
    const model = parseConfigToml(
      '[profile.default.keys]\nf13 = "volumeup"',
    );
    return render(
      <MouseIllustration
        model={model}
        activeProfile="default"
        activeLayer="base"
        selectedKey={null}
        onSelectKey={vi.fn()}
        dev={null}
        keys={G502X_KEYS}
        sideView
        layout={layoutFor({ vendor: 0x046d, product: 0x4099 })}
        {...overrides}
      />,
    );
  }

  it("renders markers for f13 through f16 when sideView is true", () => {
    const { container } = renderG502XIllo();
    for (const key of ["f13", "f14", "f15", "f16"]) {
      expect(
        container.querySelector(`[data-key="${key}"]`),
        `expected marker for ${key}`,
      ).not.toBeNull();
    }
  });

  it("clicking the f13 marker fires onSelectKey with 'f13'", () => {
    const onSelectKey = vi.fn();
    const { container } = renderG502XIllo({ onSelectKey });
    fireEvent.click(container.querySelector('[data-key="f13"]')!);
    expect(onSelectKey).toHaveBeenCalledWith("f13");
  });

  it("f13 marker has the curated label 'Top button' in its aria-label", () => {
    const { container } = renderG502XIllo({ selectedKey: "f13" });
    const marker = container.querySelector('[data-key="f13"]');
    expect(marker?.getAttribute("aria-label")).toContain("Top button");
  });
});
