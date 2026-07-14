import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HelpScreen } from "./Help";

// userEvent is not a project dependency — using fireEvent.click instead.
// Assertions are identical to the brief.

vi.mock("../lib/client", () => ({
  getStatus: vi.fn().mockResolvedValue({
    active_profile: "default", active_layers: [], suspended: false,
    focus: null, grabbed_devices: [], version: "0.1.0", config_version: 0,
  }),
  getConfig: vi.fn().mockResolvedValue(""),
  listDevices: vi.fn().mockResolvedValue([]),
  onStatus: vi.fn().mockResolvedValue(() => {}),
  onConnection: vi.fn().mockResolvedValue([() => {}, () => {}]),
  onKeyEvent: vi.fn().mockResolvedValue(() => {}),
}));

describe("HelpScreen", () => {
  it("defaults to the key tester framing and switches tabs", async () => {
    render(<HelpScreen />);
    expect(screen.getByRole("tab", { name: "Is Conduit seeing your presses?", selected: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "All hardware" }));
    expect(screen.getByRole("tab", { name: "All hardware", selected: true })).toBeInTheDocument();
  });

  it("tab ids, aria-controls/aria-labelledby wiring", () => {
    render(<HelpScreen />);
    const firstTab = screen.getByRole("tab", { name: "Is Conduit seeing your presses?" });
    expect(firstTab).toHaveAttribute("id", "help-tab-tester");
    expect(firstTab).toHaveAttribute("aria-controls", "help-panel-tester");
    const panel = document.getElementById("help-panel-tester");
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("role", "tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", "help-tab-tester");
  });

  it("roving tabindex: selected tab has tabIndex=0, others -1", () => {
    render(<HelpScreen />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0]).toHaveAttribute("tabindex", "0");
    expect(tabs[1]).toHaveAttribute("tabindex", "-1");
    expect(tabs[2]).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowRight moves focus and selection to the next tab", () => {
    render(<HelpScreen />);
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tabs[1]);
  });

  it("ArrowLeft moves focus and selection to the previous tab (wraps)", () => {
    render(<HelpScreen />);
    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    // Wraps from first to last
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tabs[2]);
  });

  it("ArrowRight wraps from last tab to first", () => {
    render(<HelpScreen />);
    const tabs = screen.getAllByRole("tab");
    // Click the last tab first to select it
    fireEvent.click(tabs[2]);
    tabs[2].focus();
    fireEvent.keyDown(tabs[2], { key: "ArrowRight" });
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(tabs[0]);
  });
});
