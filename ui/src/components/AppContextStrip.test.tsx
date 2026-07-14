import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppContextStrip } from "./AppContextStrip";

describe("AppContextStrip", () => {
  it("renders the overlay copy, switch, and guarded remove", () => {
    const onToggle = vi.fn();
    const onRemove = vi.fn();
    render(<AppContextStrip pill={{ profileName: "firefox", label: "Firefox", kind: "app", matchClass: "firefox", autoSwitch: true, icon: null, isBrowser: true }} onToggleAutoSwitch={onToggle} onRemove={onRemove} />);
    expect(screen.getByText(/When Firefox is the window you're using/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Switch automatically" }));
    expect(onToggle).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "⋯" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove Firefox settings" }));
    expect(onRemove).not.toHaveBeenCalled();  // confirm gate
    expect(screen.getByText(/Buttons will use their Everywhere settings in Firefox/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onRemove).toHaveBeenCalled();
  });
});
