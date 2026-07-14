import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { SetupStatus } from "../lib/client";
import { SetupScreen } from "./Setup";

// Full-mock pattern: avoids loading the real client.ts (which imports Tauri APIs).
// vi.hoisted() runs before vi.mock factories so MockConduitError is available in
// both the factory closure and test bodies without a dynamic import().

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const mockSetupStatus = vi.fn();
const mockSetupInstallService = vi.fn();
const mockSetupFixPermissions = vi.fn();

vi.mock("../lib/client", () => ({
  setupStatus: (...a: unknown[]) => mockSetupStatus(...a),
  setupInstallService: (...a: unknown[]) => mockSetupInstallService(...a),
  setupFixPermissions: (...a: unknown[]) => mockSetupFixPermissions(...a),
}));

// ---- Shared fixtures --------------------------------------------------------

const ALL_BROKEN: SetupStatus = {
  service_installed: false, service_running: false, daemon_connected: false,
  uinput_ok: false, evdev_ok: false, input_group: false, config_ok: true,
  binary_missing: false,
  binary_path: "/home/u/.local/bin/conduit-daemon", details: [],
};

const ALL_GREEN: SetupStatus = {
  ...ALL_BROKEN, service_installed: true, service_running: true,
  daemon_connected: true, uinput_ok: true, evdev_ok: true,
};

// ---- Reset mocks before each test ------------------------------------------

beforeEach(() => {
  mockSetupStatus.mockReset();
  mockSetupInstallService.mockReset();
  mockSetupFixPermissions.mockReset();
});

// ---- Tests -----------------------------------------------------------------

it("renders the hero copy and three steps from status", async () => {
  mockSetupStatus.mockResolvedValue(ALL_BROKEN); // service off, uinput false, evdev false
  render(<SetupScreen />);
  expect(await screen.findByText("Let's get Conduit running")).toBeInTheDocument();
  expect(screen.getByText("Background service installed")).toBeInTheDocument();
  expect(screen.getByText("Allowing Conduit to press keys for you")).toBeInTheDocument();
  expect(screen.getByText("Access to your mice and keyboards")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start using Conduit" })).toBeDisabled();
});

it("quarantines technical details behind the link", async () => {
  mockSetupStatus.mockResolvedValue({ ...ALL_BROKEN, details: ["uinput: EACCES /dev/uinput"] });
  render(<SetupScreen />);
  await screen.findByText("Let's get Conduit running");
  expect(screen.queryByText(/EACCES|uinput/)).toBeNull();
  fireEvent.click(screen.getByText("Show technical details"));
  expect(screen.getByText(/EACCES/)).toBeInTheDocument();
});

it("installs the service on Set it up and re-checks", async () => {
  mockSetupStatus.mockResolvedValueOnce(ALL_BROKEN)
    .mockResolvedValue({ ...ALL_BROKEN, service_installed: true, service_running: true, daemon_connected: true });
  mockSetupInstallService.mockResolvedValue(undefined);
  render(<SetupScreen />);
  fireEvent.click(await screen.findByRole("button", { name: "Set it up" }));
  await waitFor(() => expect(mockSetupInstallService).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start using Conduit" })).toBeEnabled());
});

it("shows the relogin instruction when the fix needs it", async () => {
  mockSetupStatus.mockResolvedValue({ ...ALL_BROKEN, service_running: true, uinput_ok: true });
  mockSetupFixPermissions.mockResolvedValue({ relogin_needed: true });
  render(<SetupScreen />);
  fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
  expect(await screen.findByText("Log out and back in, then come back — your settings will be waiting.")).toBeInTheDocument();
});

it("never renders banned words outside the details pane", async () => {
  mockSetupStatus.mockResolvedValue(ALL_BROKEN);
  const { container } = render(<SetupScreen />);
  await screen.findByText("Let's get Conduit running");
  for (const word of ["daemon", "socket", "uinput", "udev", "systemd", "polkit", "group", "profile"]) {
    expect(container.textContent!.toLowerCase()).not.toContain(word);
  }
});

it("enables Start using Conduit when all green", async () => {
  mockSetupStatus.mockResolvedValue(ALL_GREEN);
  render(<SetupScreen />);
  await screen.findByText("Let's get Conduit running");
  expect(screen.getByRole("button", { name: "Start using Conduit" })).toBeEnabled();
});
