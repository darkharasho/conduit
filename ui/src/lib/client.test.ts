import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @tauri-apps/api/core before importing client
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getStatus,
  getConfig,
  listDevices,
  listWindows,
  suspend,
  resume,
  captureNextKey,
  onStatus,
  onKeyEvent,
  onConnection,
} from "./client";
import type { Status, DeviceInfo, WireEvent } from "./client";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleStatus: Status = {
  active_profile: "default",
  active_layers: ["base"],
  suspended: false,
  focus: {
    process: "alacritty",
    class: "Alacritty",
    title: "Terminal",
  },
  grabbed_devices: ["/dev/input/event0"],
  version: "0.1.0",
};

describe("getStatus", () => {
  it("calls invoke('get_status') and returns typed Status", async () => {
    mockInvoke.mockResolvedValueOnce(sampleStatus);
    const result = await getStatus();
    expect(mockInvoke).toHaveBeenCalledWith("get_status");
    expect(result).toEqual(sampleStatus);
    expect(result.active_profile).toBe("default");
    expect(result.active_layers).toContain("base");
    expect(result.grabbed_devices).toHaveLength(1);
  });
});

describe("getConfig", () => {
  it("calls invoke('get_config') and returns string", async () => {
    mockInvoke.mockResolvedValueOnce("toml config content");
    const result = await getConfig();
    expect(mockInvoke).toHaveBeenCalledWith("get_config");
    expect(result).toBe("toml config content");
  });
});

describe("listDevices", () => {
  it("calls invoke('list_devices') and returns DeviceInfo array", async () => {
    const devices: DeviceInfo[] = [
      {
        path: "/dev/input/event0",
        name: "Keyboard",
        vendor: 0x1234,
        product: 0x5678,
        is_keyboard: true,
        is_mouse: false,
        grabbed: true,
        id: "1234:5678/Keyboard",
        class: "keyboard",
        phys: "",
      },
    ];
    mockInvoke.mockResolvedValueOnce(devices);
    const result = await listDevices();
    expect(mockInvoke).toHaveBeenCalledWith("list_devices");
    expect(result).toEqual(devices);
    expect(result[0].is_keyboard).toBe(true);
  });
});

describe("listWindows", () => {
  it("calls invoke('list_windows') and returns FocusInfo array", async () => {
    const windows = [{ process: "firefox", class: "firefox", title: "Web" }];
    mockInvoke.mockResolvedValueOnce(windows);
    const result = await listWindows();
    expect(mockInvoke).toHaveBeenCalledWith("list_windows");
    expect(result).toEqual(windows);
  });
});

describe("suspend", () => {
  it("calls invoke('suspend')", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await suspend();
    expect(mockInvoke).toHaveBeenCalledWith("suspend");
  });
});

describe("resume", () => {
  it("calls invoke('resume')", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await resume();
    expect(mockInvoke).toHaveBeenCalledWith("resume");
  });
});

describe("captureNextKey", () => {
  it("calls invoke('capture_next_key') and returns CapturedKey", async () => {
    const captured = { name: "Enter", code: 28 };
    mockInvoke.mockResolvedValueOnce(captured);
    const result = await captureNextKey();
    expect(mockInvoke).toHaveBeenCalledWith("capture_next_key");
    expect(result.name).toBe("Enter");
    expect(result.code).toBe(28);
  });
});

describe("onStatus", () => {
  it("registers a listener for conduit://status events", () => {
    const cb = vi.fn();
    const unlistenFn = vi.fn();
    mockListen.mockReturnValueOnce(Promise.resolve(unlistenFn));

    onStatus(cb);

    expect(mockListen).toHaveBeenCalledWith(
      "conduit://status",
      expect.any(Function)
    );
  });

  it("invokes callback with Status payload", async () => {
    const cb = vi.fn();
    const unlistenFn = vi.fn();
    let capturedHandler: ((event: { payload: Status }) => void) | null = null;

    mockListen.mockImplementationOnce((_channel, handler) => {
      capturedHandler = handler as (event: { payload: Status }) => void;
      return Promise.resolve(unlistenFn);
    });

    await onStatus(cb);

    // TypeScript doesn't narrow closure-assigned variables; use non-null assertion
    capturedHandler!({ payload: sampleStatus });

    expect(cb).toHaveBeenCalledWith(sampleStatus);
  });
});

describe("onKeyEvent", () => {
  it("registers a listener for conduit://event events", () => {
    const cb = vi.fn();
    const unlistenFn = vi.fn();
    mockListen.mockReturnValueOnce(Promise.resolve(unlistenFn));

    onKeyEvent(cb);

    expect(mockListen).toHaveBeenCalledWith(
      "conduit://event",
      expect.any(Function)
    );
  });

  it("invokes callback with WireEvent payload", async () => {
    const cb = vi.fn();
    const unlistenFn = vi.fn();
    let capturedHandler: ((event: { payload: WireEvent }) => void) | null =
      null;

    mockListen.mockImplementationOnce((_channel, handler) => {
      capturedHandler = handler as (event: { payload: WireEvent }) => void;
      return Promise.resolve(unlistenFn);
    });

    await onKeyEvent(cb);

    const wireEvent: WireEvent = {
      phase: "pre",
      key_name: "A",
      code: 30,
      state: "press",
      time_us: 1234567890,
    };

    // TypeScript doesn't narrow closure-assigned variables; use non-null assertion
    capturedHandler!({ payload: wireEvent });

    expect(cb).toHaveBeenCalledWith(wireEvent);
  });
});

describe("onConnection", () => {
  it("registers listeners for conduit://connected and conduit://disconnected", () => {
    const cb = vi.fn();
    const unlistenFn = vi.fn();
    mockListen.mockReturnValue(Promise.resolve(unlistenFn));

    onConnection(cb);

    expect(mockListen).toHaveBeenCalledWith(
      "conduit://connected",
      expect.any(Function)
    );
    expect(mockListen).toHaveBeenCalledWith(
      "conduit://disconnected",
      expect.any(Function)
    );
  });
});
