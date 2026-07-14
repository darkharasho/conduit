import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupStatus } from "../lib/client";
import { SetupScreen } from "./Setup";

// Full-mock pattern: avoids loading the real client.ts (which imports Tauri APIs).
// vi.hoisted() runs before vi.mock factories so MockConduitError is available in
// both the factory closure and test bodies without a dynamic import().

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
const mockSetupFixPermissions = vi.fn();
const mockRestartEngine = vi.fn();
const mockCollectReport = vi.fn();

vi.mock("../lib/client", () => ({
  ConduitError: ConduitError,
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

it("recovery shows error when restartEngine fails and still shows Copy report", async () => {
  mockSetupStatus.mockResolvedValue({ ...ALL_GREEN, daemon_connected: false, service_running: false });
  mockRestartEngine.mockRejectedValue(new ConduitError("internal", "systemctl failed", "unit not found"));
  mockCollectReport.mockResolvedValue("== check ==\n{}");
  render(<SetupScreen variant="recovery" />);
  expect(await screen.findByText("Conduit's engine stopped")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Start it again" }));
  await waitFor(() => expect(mockRestartEngine).toHaveBeenCalled());
  expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
  expect(screen.queryByText(/unit not found/)).toBeNull();
  expect(screen.getByRole("button", { name: "Copy report for a bug" })).toBeInTheDocument();
});

it("shows permission-denied title when fix-permissions is cancelled via pkexec", async () => {
  // uinput step is the active attention step; service is running
  mockSetupStatus.mockResolvedValue({ ...ALL_BROKEN, service_running: true });
  mockSetupFixPermissions.mockRejectedValue(
    new ConduitError("permission-denied", "You closed the password prompt", "pkexec status 126")
  );
  render(<SetupScreen />);
  fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
  // presentError("permission-denied") → "Conduit doesn't have permission to do that"
  expect(await screen.findByText("Conduit doesn't have permission to do that")).toBeInTheDocument();
  // raw technical detail must never leak into the UI
  expect(screen.queryByText(/pkexec/)).toBeNull();
  expect(screen.queryByText(/126/)).toBeNull();
});

// A failing fake-timer assertion must not leak fake timers into later tests.
afterEach(() => {
  vi.useRealTimers();
});

it("re-checks on interval and on window focus", async () => {
  vi.useFakeTimers();
  mockSetupStatus.mockResolvedValue(ALL_BROKEN);
  render(<SetupScreen />);
  await act(async () => { await Promise.resolve(); });
  const initial = mockSetupStatus.mock.calls.length;
  await act(async () => { vi.advanceTimersByTime(5100); });
  expect(mockSetupStatus.mock.calls.length).toBeGreaterThan(initial);
  const afterTick = mockSetupStatus.mock.calls.length;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(mockSetupStatus.mock.calls.length).toBeGreaterThan(afterTick);
  vi.useRealTimers();
});

it("skips overlapping re-checks via in-flight guard", async () => {
  vi.useFakeTimers();
  let resolveSetupStatus: ((val: SetupStatus) => void) | undefined;
  const statusPromise = new Promise<SetupStatus>((resolve) => {
    resolveSetupStatus = resolve;
  });
  mockSetupStatus.mockReturnValue(statusPromise);
  render(<SetupScreen />);
  await act(async () => { await Promise.resolve(); });
  // The mount recheck is guarded and still in flight (hanging promise).
  expect(mockSetupStatus.mock.calls.length).toBe(1);
  // Two ticks while in flight: both skipped by the guard.
  await act(async () => { vi.advanceTimersByTime(5100); });
  await act(async () => { vi.advanceTimersByTime(5100); });
  expect(mockSetupStatus.mock.calls.length).toBe(1);
  // Resolve the mount call; the guard clears and the next tick fetches again.
  resolveSetupStatus!(ALL_BROKEN);
  await act(async () => { await Promise.resolve(); });
  await act(async () => { vi.advanceTimersByTime(5100); });
  expect(mockSetupStatus.mock.calls.length).toBe(2);
});

it("recovery shows success state when daemon becomes connected", async () => {
  mockSetupStatus.mockResolvedValueOnce({ ...ALL_GREEN, daemon_connected: false, service_running: false });
  render(<SetupScreen variant="recovery" />);
  expect(await screen.findByText("Conduit's engine stopped")).toBeInTheDocument();
  // Simulate daemon reconnecting
  mockSetupStatus.mockResolvedValue(ALL_GREEN);
  window.dispatchEvent(new Event("focus"));
  await waitFor(() => expect(screen.queryByText("Conduit's engine stopped")).not.toBeInTheDocument());
  expect(screen.getByText("Everything's running again.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start using Conduit" })).toBeInTheDocument();
});

describe("phase 6 nits", () => {
  it("item 5: after ALL_GREEN status, advancing 15s adds no more setupStatus calls", async () => {
    vi.useFakeTimers();
    // First call returns ALL_GREEN immediately
    mockSetupStatus.mockResolvedValue(ALL_GREEN);
    render(<SetupScreen />);
    // Flush microtasks so the initial recheck resolves
    await act(async () => { await Promise.resolve(); });
    const callsAfterResolve = mockSetupStatus.mock.calls.length;
    // Advance 15s — polling should have stopped because allSettled=true
    await act(async () => { vi.advanceTimersByTime(15000); });
    // Give any enqueued microtasks a chance to run
    await act(async () => { await Promise.resolve(); });
    // No additional calls should have been made after the initial one
    expect(mockSetupStatus.mock.calls.length).toBe(callsAfterResolve);
  });

  it("item 6: recovery variant with unresolved status shows spinner not first-run hero", async () => {
    // Never resolves → status stays null
    mockSetupStatus.mockReturnValue(new Promise(() => {}));
    render(<SetupScreen variant="recovery" />);
    // The first-run hero must NOT appear
    expect(screen.queryByText("Let's get Conduit running")).toBeNull();
    // The loading class must be present
    expect(document.querySelector(".setup__loading")).not.toBeNull();
  });

  it("item 8: when relogin_needed, both uinput and evdev show relogin note and Allow is suppressed", async () => {
    // Service running, uinput broken → uinput is the attention step
    mockSetupStatus.mockResolvedValue({ ...ALL_BROKEN, service_running: true });
    mockSetupFixPermissions.mockResolvedValue({ relogin_needed: true });
    render(<SetupScreen />);
    // Click Allow for uinput (the first attention step when service is running)
    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    // Relogin note should appear
    await waitFor(() =>
      expect(screen.getAllByText("Log out and back in, then come back — your settings will be waiting.").length).toBeGreaterThan(0)
    );
    // Allow button should be suppressed (no more Allow buttons visible)
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });
});
