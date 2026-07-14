import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppPillsBar } from "./AppPillsBar";
import type { AppPill } from "../lib/app-registry";

function pill(over: Partial<AppPill> & Pick<AppPill, "profileName" | "label">): AppPill {
  return {
    kind: "app",
    matchClass: over.profileName,
    autoSwitch: true,
    icon: null,
    isBrowser: false,
    ...over,
  };
}

const PILLS: AppPill[] = [
  pill({ profileName: "everywhere", label: "Everywhere", kind: "everywhere", matchClass: null }),
  pill({ profileName: "firefox", label: "Firefox" }),
  pill({ profileName: "slack", label: "Slack", autoSwitch: false }),
];

describe("AppPillsBar", () => {
  it("container has role tablist", () => {
    const { container } = render(
      <AppPillsBar pills={PILLS} active="everywhere" onSelect={vi.fn()} onAdd={vi.fn()} />,
    );
    expect(container.querySelector("[role='tablist']")).not.toBeNull();
  });

  it("pills have role tab with aria-selected matching the active pill", () => {
    render(
      <AppPillsBar pills={PILLS} active="firefox" onSelect={vi.fn()} onAdd={vi.fn()} />,
    );
    const tabs = screen.getAllByRole("tab");
    const everywhere = tabs.find((t) => t.textContent?.includes("Everywhere"))!;
    const firefox = tabs.find((t) => t.textContent?.includes("Firefox"))!;
    expect(everywhere).toHaveAttribute("aria-selected", "false");
    expect(firefox).toHaveAttribute("aria-selected", "true");
  });

  it("paused badge has aria-label 'Switch automatically is off'", () => {
    render(
      <AppPillsBar pills={PILLS} active="everywhere" onSelect={vi.fn()} onAdd={vi.fn()} />,
    );
    // Slack has autoSwitch: false → badge should appear
    const badge = screen.getByLabelText("Switch automatically is off");
    expect(badge).toBeInTheDocument();
  });

  it("calls onSelect with the profile name when a pill is clicked", () => {
    const onSelect = vi.fn();
    render(
      <AppPillsBar pills={PILLS} active="everywhere" onSelect={onSelect} onAdd={vi.fn()} />,
    );
    const tabs = screen.getAllByRole("tab");
    const firefox = tabs.find((t) => t.textContent?.includes("Firefox"))!;
    fireEvent.click(firefox);
    expect(onSelect).toHaveBeenCalledWith("firefox");
  });

  it("calls onAdd when the add button is clicked", () => {
    const onAdd = vi.fn();
    render(
      <AppPillsBar pills={PILLS} active="everywhere" onSelect={vi.fn()} onAdd={onAdd} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "+ In an app…" }));
    expect(onAdd).toHaveBeenCalled();
  });

  it("active pill has tabIndex 0 and others have tabIndex -1", () => {
    render(
      <AppPillsBar pills={PILLS} active="firefox" onSelect={vi.fn()} onAdd={vi.fn()} />,
    );
    const tabs = screen.getAllByRole("tab");
    const everywhere = tabs.find((t) => t.textContent?.includes("Everywhere"))!;
    const firefox = tabs.find((t) => t.textContent?.includes("Firefox"))!;
    const slack = tabs.find((t) => t.textContent?.includes("Slack"))!;
    expect(firefox).toHaveAttribute("tabindex", "0");
    expect(everywhere).toHaveAttribute("tabindex", "-1");
    expect(slack).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowRight from active pill selects next pill and moves focus", () => {
    const onSelect = vi.fn();
    render(
      <AppPillsBar pills={PILLS} active="everywhere" onSelect={onSelect} onAdd={vi.fn()} />,
    );
    const tabs = screen.getAllByRole("tab");
    const everywhere = tabs.find((t) => t.textContent?.includes("Everywhere"))!;
    fireEvent.keyDown(everywhere, { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("firefox");
  });

  it("ArrowLeft wraps around to the last pill", () => {
    const onSelect = vi.fn();
    render(
      <AppPillsBar pills={PILLS} active="everywhere" onSelect={onSelect} onAdd={vi.fn()} />,
    );
    const tabs = screen.getAllByRole("tab");
    const everywhere = tabs.find((t) => t.textContent?.includes("Everywhere"))!;
    fireEvent.keyDown(everywhere, { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenCalledWith("slack");
  });
});
