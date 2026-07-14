import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeviceArt } from "./DeviceArt";

describe("DeviceArt", () => {
  it.each(["gaming-mouse", "mmo-mouse", "mouse", "keyboard"] as const)(
    "renders an aria-hidden svg for %s",
    (archetype) => {
      const { container } = render(<DeviceArt archetype={archetype} />);
      const svg = container.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg).toHaveAttribute("aria-hidden", "true");
    },
  );
  it("honors the width prop", () => {
    const { container } = render(<DeviceArt archetype="mouse" width={24} />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("width", "24");
    expect(svg).toHaveAttribute("aria-hidden", "true");
  });
});
