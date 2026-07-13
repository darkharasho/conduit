import { render, screen, fireEvent, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceInfo, Status } from "../lib/client";
import { parseConfigToml } from "../lib/config-model";
import { HomeScreen } from "./Home";

// Note: @testing-library/user-event is not a project dependency; using
// fireEvent.click from @testing-library/react instead. Assertions are identical.
//
// Note: The spread vi.mock pattern from the brief (async orig => ...(await orig()))
// is replaced with a full-mock pattern to avoid loading the real client.ts (which
// imports Tauri APIs that need separate mocks). ConduitError is re-implemented
// with the same interface via vi.hoisted(). Assertions are identical.
//
// Note: beforeEach(() => { ... }) must use a block body, NOT an arrow expression.
// vi.fn().mockReset() returns the mock itself (a function). An expression-body
// beforeEach would return that function to vitest, which then calls it as a
// "cleanup hook" after the test — causing a spurious second call to listDevices()
// and a false unhandledRejection. Block body: void return, no cleanup registered.

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const mockListDevices = vi.fn();
// Captured onStatus callbacks so tests can fire synthetic status pushes.
let capturedStatusCallbacks: Array<(s: Status) => void> = [];
const mockOnStatus = vi.fn((cb: (s: Status) => void) => {
  capturedStatusCallbacks.push(cb);
  return Promise.resolve(() => {});
});

// vi.hoisted() runs before vi.mock factories, so MockConduitError is available
// both in the factory closure and in test bodies without a dynamic import().
const { MockConduitError } = vi.hoisted(() => {
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
  return { MockConduitError };
});

vi.mock("../lib/client", () => ({
  listDevices: (...a: unknown[]) => mockListDevices(...a),
  onStatus: (...a: unknown[]) => mockOnStatus(a[0] as (s: Status) => void),
  ConduitError: MockConduitError,
}));

function node(over: Partial<DeviceInfo>): DeviceInfo {
  return {
    path: "/dev/input/event0", name: "Some Device", vendor: 0x046d,
    product: 0x4099, is_keyboard: false, is_mouse: true, grabbed: true,
    id: "046d:4099/x", class: "mouse", phys: "", keys: [], wheel: true,
    hwheel: false, ...over,
  };
}

const MODEL = parseConfigToml(`
[profile.default.keys]
capslock = "esc"
[profile.firefox]
match = { class = "firefox" }
[profile.firefox.keys]
f1 = "back"
[profile.default.device."046d:c24a/G600".keys]
mouse4 = "copy"
`);

beforeEach(() => {
  mockListDevices.mockReset();
  capturedStatusCallbacks = [];
  mockOnStatus.mockClear();
});

describe("HomeScreen", () => {
  it("renders heading, a card per physical device, and opens on click", async () => {
    mockListDevices.mockResolvedValue([node({})]);
    const onOpen = vi.fn();
    render(<HomeScreen model={MODEL} connected={true} onOpenDevice={onOpen} />);
    expect(screen.getByText("Your devices")).toBeInTheDocument();
    expect(screen.getByText("Click a device to change what its buttons do.")).toBeInTheDocument();
    const card = await screen.findByRole("button", { name: /Logitech G502 X/ });
    expect(screen.getByText("Working")).toBeInTheDocument();
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ key: "046d:4099", name: "Logitech G502 X" }),
    );
  });

  it("shows remembered devices with the spec copy", async () => {
    mockListDevices.mockResolvedValue([node({})]);
    render(<HomeScreen model={MODEL} connected={true} onOpenDevice={() => {}} />);
    expect(await screen.findByText("Remembered devices")).toBeInTheDocument();
    expect(screen.getByText(/Logitech G600 — not connected/)).toBeInTheDocument();
    expect(screen.getByText("Its settings are saved and will come back when you plug it in.")).toBeInTheDocument();
  });

  it("shows the empty state when nothing is connected", async () => {
    mockListDevices.mockResolvedValue([]);
    render(<HomeScreen model={null} connected={true} onOpenDevice={() => {}} />);
    expect(await screen.findByText("Plug in a mouse or keyboard to get started")).toBeInTheDocument();
  });

  it("renders plain-language errors through presentError, never raw strings", async () => {
    const { ConduitError } = await import("../lib/client");
    mockListDevices.mockRejectedValue(
      new ConduitError("engine-not-running", "connect refused", "conduit.sock ECONNREFUSED"),
    );
    render(<HomeScreen model={null} connected={false} onOpenDevice={() => {}} />);
    expect(await screen.findByText("Conduit's engine isn't running")).toBeInTheDocument();
    expect(screen.queryByText(/ECONNREFUSED|conduit\.sock/)).toBeNull();
  });

  it("F1: refreshes device list when a status push reports a changed grabbed_devices", async () => {
    // Initial render: no devices → empty state visible
    mockListDevices.mockResolvedValue([]);
    render(<HomeScreen model={null} connected={true} onOpenDevice={() => {}} />);
    expect(await screen.findByText("Plug in a mouse or keyboard to get started")).toBeInTheDocument();

    // Now a device plugs in: status push arrives with a changed grabbed_devices
    // and listDevices now returns one device
    mockListDevices.mockResolvedValue([node({})]);
    const baseStatus: Status = {
      active_profile: "default",
      active_layers: ["base"],
      suspended: false,
      focus: null,
      grabbed_devices: ["/dev/input/event0"],
      version: "0.1.0",
      config_version: 0,
    };
    await act(async () => {
      for (const cb of capturedStatusCallbacks) cb(baseStatus);
    });

    expect(await screen.findByRole("button", { name: /Logitech G502 X/ })).toBeInTheDocument();
    expect(screen.queryByText("Plug in a mouse or keyboard to get started")).toBeNull();
  });

  it("F1: does not re-fetch when grabbed_devices is unchanged in a status push", async () => {
    mockListDevices.mockResolvedValue([node({})]);
    render(<HomeScreen model={null} connected={true} onOpenDevice={() => {}} />);
    await screen.findByRole("button", { name: /Logitech G502 X/ });
    const callCountAfterMount = mockListDevices.mock.calls.length;

    // Push same grabbed_devices value — should not trigger another listDevices call
    const sameStatus: Status = {
      active_profile: "default",
      active_layers: ["base"],
      suspended: false,
      focus: null,
      grabbed_devices: [],
      version: "0.1.0",
      config_version: 0,
    };
    // First push establishes the ref; second push with same value must not refetch
    await act(async () => {
      for (const cb of capturedStatusCallbacks) cb(sameStatus);
    });
    await act(async () => {
      for (const cb of capturedStatusCallbacks) cb(sameStatus);
    });
    expect(mockListDevices.mock.calls.length).toBe(callCountAfterMount + 1); // only the first push
  });
});
