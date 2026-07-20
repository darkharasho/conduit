import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, it, expect, beforeEach } from "vitest";

const enable = vi.fn(async (..._a: unknown[]) => {});
const disable = vi.fn(async (..._a: unknown[]) => {});
let enabled = false;
vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: (...a: unknown[]) => enable(...a),
  disable: (...a: unknown[]) => disable(...a),
  isEnabled: async () => enabled,
}));

import { SettingsScreen } from "./Settings";

beforeEach(() => { enabled = false; enable.mockClear(); disable.mockClear(); });

it("reflects isEnabled on mount and toggles on", async () => {
  render(<SettingsScreen />);
  const toggle = await screen.findByRole("switch", { name: /open on startup/i });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  fireEvent.click(toggle);
  await waitFor(() => expect(enable).toHaveBeenCalled());
});

it("toggles off when already enabled", async () => {
  enabled = true;
  render(<SettingsScreen />);
  const toggle = await screen.findByRole("switch", { name: /open on startup/i });
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  fireEvent.click(toggle);
  await waitFor(() => expect(disable).toHaveBeenCalled());
});
