import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, it, expect, beforeEach, describe } from "vitest";
import type { SetupStatus } from "../lib/client";

const enable = vi.fn(async (..._a: unknown[]) => {});
const disable = vi.fn(async (..._a: unknown[]) => {});
let enabled = false;
vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: (...a: unknown[]) => enable(...a),
  disable: (...a: unknown[]) => disable(...a),
  isEnabled: async () => enabled,
}));

// Full-mock pattern (see Setup.test.tsx): avoids loading real client.ts, which
// imports Tauri APIs.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const { ConduitError } = vi.hoisted(() => {
  class MockConduitError extends Error {
    code: string;
    detail: string;
    constructor(code: string, message: string, detail = "") {
      super(message);
      this.name = "ConduitError";
      this.code = code;
      this.detail = detail;
    }
  }
  return { ConduitError: MockConduitError };
});

const mockSetupStatus = vi.fn();
const mockSetupInstallService = vi.fn();

vi.mock("../lib/client", () => ({
  ConduitError: ConduitError,
  setupStatus: (...a: unknown[]) => mockSetupStatus(...a),
  setupInstallService: (...a: unknown[]) => mockSetupInstallService(...a),
}));

// App updater: mock the wrapper lib so tests never touch the Tauri plugin.
const mockCheckForAppUpdate = vi.fn();
vi.mock("../lib/app-update", () => ({
  checkForAppUpdate: (...a: unknown[]) => mockCheckForAppUpdate(...a),
}));

import { SettingsScreen } from "./Settings";

const BASE_STATUS: SetupStatus = {
  service_installed: true, service_running: true, daemon_connected: true,
  uinput_ok: true, evdev_ok: true, input_group: true, config_ok: true,
  binary_missing: false, binary_path: "/home/u/.local/bin/conduit-daemon",
  details: [], daemon_version: "0.1.0", app_version: "0.1.0",
};

beforeEach(() => {
  enabled = false;
  enable.mockClear();
  disable.mockClear();
  mockSetupStatus.mockReset();
  mockSetupInstallService.mockReset();
  mockSetupStatus.mockResolvedValue(BASE_STATUS);
  mockCheckForAppUpdate.mockReset();
  mockCheckForAppUpdate.mockResolvedValue(null);
});

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

describe("engine update affordance", () => {
  it("shows drift row when daemon_version differs from app_version", async () => {
    mockSetupStatus.mockResolvedValue({ ...BASE_STATUS, daemon_version: "0.0.9", app_version: "0.1.0" });
    render(<SettingsScreen />);
    expect(await screen.findByText("Engine update available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update now" })).toBeInTheDocument();
  });

  it("hides the row when versions are equal", async () => {
    mockSetupStatus.mockResolvedValue({ ...BASE_STATUS, daemon_version: "0.1.0", app_version: "0.1.0" });
    render(<SettingsScreen />);
    await screen.findByRole("switch", { name: /open on startup/i });
    expect(screen.queryByText("Engine update available")).toBeNull();
  });

  it("hides the app update row when no update is available", async () => {
    render(<SettingsScreen />);
    await screen.findByRole("switch", { name: /open on startup/i });
    expect(screen.queryByText("App update available")).toBeNull();
  });

  it("shows the app update row and installs on click", async () => {
    const install = vi.fn(async () => {});
    mockCheckForAppUpdate.mockResolvedValue({ version: "0.3.0", install });
    render(<SettingsScreen />);
    expect(await screen.findByText("App update available")).toBeInTheDocument();
    expect(screen.getByText(/Conduit v0\.3\.0 is ready/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update & restart" }));
    await waitFor(() => expect(install).toHaveBeenCalled());
  });

  it("surfaces an error when install fails", async () => {
    const install = vi.fn(async () => { throw new Error("network"); });
    mockCheckForAppUpdate.mockResolvedValue({ version: "0.3.0", install });
    render(<SettingsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Update & restart" }));
    expect(await screen.findByText(/Couldn't install the update/)).toBeInTheDocument();
  });

  it("calls setupInstallService on Update now and re-polls setupStatus", async () => {
    mockSetupStatus
      .mockResolvedValueOnce({ ...BASE_STATUS, daemon_version: "0.0.9", app_version: "0.1.0" })
      .mockResolvedValue({ ...BASE_STATUS, daemon_version: "0.1.0", app_version: "0.1.0" });
    mockSetupInstallService.mockResolvedValue(undefined);
    render(<SettingsScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Update now" }));
    await waitFor(() => expect(mockSetupInstallService).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText("Engine update available")).toBeNull());
  });
});
