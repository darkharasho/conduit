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
});
