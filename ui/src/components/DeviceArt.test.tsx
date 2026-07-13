import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DeviceArt } from "./DeviceArt";

describe("DeviceArt", () => {
  it.each(["gaming-mouse", "mmo-mouse", "mouse", "keyboard"] as const)(
    "renders an svg for %s",
    (archetype) => {
      render(<DeviceArt archetype={archetype} />);
      const img = screen.getByRole("img", { name: archetype });
      expect(img.tagName.toLowerCase()).toBe("svg");
    },
  );
  it("honors the width prop", () => {
    render(<DeviceArt archetype="mouse" width={24} />);
    expect(screen.getByRole("img", { name: "mouse" })).toHaveAttribute("width", "24");
  });
});
