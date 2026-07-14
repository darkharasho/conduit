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
const mockRestartEngine = vi.fn();
const mockCollectReport = vi.fn();

vi.mock("../lib/client", () => ({
  setupStatus: (...a: unknown[]) => mockSetupStatus(...a),
  setupInstallService: (...a: unknown[]) => mockSetupInstallService(...a),
  setupFixPermissions: (...a: unknown[]) => mockSetupFixPermissions(...a),
  restartEngine: (...a: unknown[]) => mockRestartEngine(...a),
  collectReport: (...a: unknown[]) => mockCollectReport(...a),
}));

// jsdom lacks navigator.clipboard — stub it for tests that use collectReport
Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });

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
  mockRestartEngine.mockReset();
  mockCollectReport.mockReset();
  vi.mocked(navigator.clipboard.writeText).mockResolvedValue(undefined);
});

// ---- Tests -----------------------------------------------------------------

it("renders the hero copy and three steps from status", async () => {
  mockSetupStatus.mockResolvedValue(ALL_BROKEN); // service off, uinput false, evdev false
  render(<SetupScreen />);
  expect(await screen.findByText("Let's get Conduit running")).toBeInTheDocument();
  expect(screen.getByText("Conduit needs a couple of one-time permissions to remap your devices. You'll be asked for your password once.")).toBeInTheDocument();
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

it("shows waiting text while permission fix is in-flight for uinput", async () => {
  mockSetupStatus.mockResolvedValue({ ...ALL_BROKEN, service_running: true });
  let resolveFixPermissions: ((val: any) => void) | null = null;
  const fixPromise = new Promise((resolve) => {
    resolveFixPermissions = resolve;
  });
  mockSetupFixPermissions.mockReturnValue(fixPromise);

  render(<SetupScreen />);
  await screen.findByText("Let's get Conduit running");

  // Initially the waiting text is not visible
  expect(screen.queryByText("Waiting for your password in the system dialog…")).not.toBeInTheDocument();

  // Click Allow to start the permission fix
  fireEvent.click(screen.getByRole("button", { name: "Allow" }));

  // Now the waiting text should be visible while the promise is unresolved
  await waitFor(() =>
    expect(screen.getByText("Waiting for your password in the system dialog…")).toBeInTheDocument()
  );

  // Resolve the promise and re-check status
  mockSetupStatus.mockResolvedValue({ ...ALL_BROKEN, service_running: true, uinput_ok: true });
  resolveFixPermissions!({ relogin_needed: false });

  // After resolution, the waiting text should disappear
  await waitFor(() =>
    expect(screen.queryByText("Waiting for your password in the system dialog…")).not.toBeInTheDocument()
  );
});

it("recovery shows Start it again and escalates to Copy report", async () => {
  mockSetupStatus.mockResolvedValue({ ...ALL_GREEN, daemon_connected: false, service_running: false });
  mockRestartEngine.mockResolvedValue(undefined); // restart "succeeds" but daemon stays down
  mockCollectReport.mockResolvedValue("== check ==\n{}");
  render(<SetupScreen variant="recovery" />);
  expect(await screen.findByText("Conduit's engine stopped")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Start it again" }));
  await waitFor(() => expect(mockRestartEngine).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole("button", { name: "Copy report for a bug" }));
  await waitFor(() => expect(screen.getByText("Copied. Paste it into a bug report.")).toBeInTheDocument());
});

it("recovery falls through to first-run when the service was never installed", async () => {
  mockSetupStatus.mockResolvedValue(ALL_BROKEN); // service_installed false
  render(<SetupScreen variant="recovery" />);
  expect(await screen.findByText("Let's get Conduit running")).toBeInTheDocument();
});
