import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppContextStrip } from "./AppContextStrip";

const PILL = {
  profileName: "firefox",
  label: "Firefox",
  kind: "app" as const,
  matchClass: "firefox",
  autoSwitch: true,
  icon: null,
  isBrowser: true,
};

describe("AppContextStrip", () => {
  it("renders the overlay copy, switch, and guarded remove", () => {
    const onToggle = vi.fn();
    const onRemove = vi.fn();
    render(<AppContextStrip pill={PILL} onToggleAutoSwitch={onToggle} onRemove={onRemove} />);
    expect(screen.getByText(/When Firefox is the window you're using, the highlighted buttons change/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Switch automatically" }));
    expect(onToggle).toHaveBeenCalledWith(false);
    // Menu button now has aria-label "More options" (visible text is still ⋯)
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Firefox settings" }));
    expect(onRemove).not.toHaveBeenCalled();  // confirm gate
    expect(screen.getByText(/Buttons will use their Everywhere settings in Firefox/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalled();
  });

  it("Escape key closes the open menu", () => {
    render(<AppContextStrip pill={PILL} onToggleAutoSwitch={vi.fn()} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.getByRole("button", { name: "Remove Firefox settings" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("button", { name: "Remove Firefox settings" })).toBeNull();
  });

  it("click outside closes the open menu", () => {
    render(<AppContextStrip pill={PILL} onToggleAutoSwitch={vi.fn()} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.getByRole("button", { name: "Remove Firefox settings" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("button", { name: "Remove Firefox settings" })).toBeNull();
  });

  it("menu button visible text is ⋯", () => {
    render(<AppContextStrip pill={PILL} onToggleAutoSwitch={vi.fn()} onRemove={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "More options" });
    expect(btn.textContent).toBe("⋯");
  });

  it("mouseDown on menu button while menu is open closes it exactly once (not re-opened)", () => {
    render(<AppContextStrip pill={PILL} onToggleAutoSwitch={vi.fn()} onRemove={vi.fn()} />);
    const menuBtn = screen.getByRole("button", { name: "More options" });
    // Open the menu
    fireEvent.click(menuBtn);
    expect(screen.getByRole("button", { name: "Remove Firefox settings" })).toBeInTheDocument();
    // Simulate the browser's mousedown on the button while menu is open.
    // The document mousedown handler would close it; stopPropagation on the button must
    // prevent that race so the subsequent click can toggle it closed (not re-open it).
    fireEvent.mouseDown(menuBtn);
    fireEvent.click(menuBtn);
    // Menu should now be closed
    expect(screen.queryByRole("button", { name: "Remove Firefox settings" })).toBeNull();
  });
});

describe("AppContextStrip — prose variants", () => {
  const ADVANCED_PILL = {
    profileName: "custom_rule",
    label: "Custom rule",
    kind: "advanced" as const,
    matchClass: null,
    autoSwitch: false,
    icon: null,
    isBrowser: false,
  };

  it("app pill: prose says 'When {label} is the window you're using…'", () => {
    render(<AppContextStrip pill={PILL} onToggleAutoSwitch={vi.fn()} onRemove={vi.fn()} />);
    expect(
      screen.getByText(/When Firefox is the window you're using, the highlighted buttons change/)
    ).toBeInTheDocument();
  });

  it("advanced pill: prose says 'When your custom rule matches, the highlighted buttons change. Everything else keeps its Everywhere setting.'", () => {
    render(<AppContextStrip pill={ADVANCED_PILL} onToggleAutoSwitch={vi.fn()} onRemove={vi.fn()} />);
    expect(
      screen.getByText("When your custom rule matches, the highlighted buttons change. Everything else keeps its Everywhere setting.")
    ).toBeInTheDocument();
    // Must NOT contain the old app-style sentence
    expect(screen.queryByText(/When Custom rule is the window/)).toBeNull();
  });
});
