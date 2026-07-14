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
  setConfig,
  listDevices,
  listWindows,
  suspend,
  resume,
  captureNextKey,
  onStatus,
  onKeyEvent,
  onConnection,
  ConduitError,
  listInstalledApps,
  setupStatus,
  setupInstallService,
  setupFixPermissions,
  restartEngine,
  collectReport,
} from "./client";
import type {
  Status,
  DeviceInfo,
  WireEvent,
  InstalledApp,
  SetupStatus,
  PermissionFixOutcome,
} from "./client";

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
  config_version: 0,
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
        keys: [30, 31],
        wheel: false,
        hwheel: false,
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
      device: "",
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

describe("typed errors", () => {
  it("wraps structured payload rejections in ConduitError", async () => {
    mockInvoke.mockRejectedValueOnce({
      code: "config-invalid",
      message: "config rejected",
      detail: "expected ']' at line 3",
    });
    const err = await setConfig("bad").catch((e) => e);
    expect(err).toBeInstanceOf(ConduitError);
    expect(err.code).toBe("config-invalid");
    expect(err.detail).toContain("line 3");
  });

  it("maps unknown rejection shapes to code unknown", async () => {
    mockInvoke.mockRejectedValueOnce("socket exploded");
    const err = await getStatus().catch((e) => e);
    expect(err).toBeInstanceOf(ConduitError);
    expect(err.code).toBe("unknown");
    expect(err.message).toBe("socket exploded");
  });

  it("setConfig resolves with the applied version", async () => {
    mockInvoke.mockResolvedValueOnce(42);
    await expect(setConfig("[profile.default.keys]\n")).resolves.toBe(42);
  });
});

describe("listInstalledApps", () => {
  it("calls invoke('list_installed_apps') and passes through the array", async () => {
    const apps: InstalledApp[] = [
      {
        app_id: "org.mozilla.firefox",
        name: "Firefox",
        wm_class: "firefox",
        categories: ["Network", "WebBrowser"],
        icon: "data:image/png;base64,abc123",
      },
      {
        app_id: "org.gnome.Nautilus",
        name: "Files",
        wm_class: null,
        categories: ["System", "FileManager"],
        icon: null,
      },
    ];
    mockInvoke.mockResolvedValueOnce(apps);
    const result = await listInstalledApps();
    expect(mockInvoke).toHaveBeenCalledWith("list_installed_apps");
    expect(result).toEqual(apps);
    expect(result).toHaveLength(2);
    expect(result[0].app_id).toBe("org.mozilla.firefox");
    expect(result[1].icon).toBeNull();
  });
});

describe("setupStatus", () => {
  it("calls invoke('setup_status') and returns SetupStatus", async () => {
    const status: SetupStatus = {
      service_installed: true,
      service_running: true,
      daemon_connected: true,
      uinput_ok: true,
      evdev_ok: true,
      input_group: true,
      config_ok: true,
      binary_missing: false,
      binary_path: "/usr/bin/conduit-daemon",
      details: ["systemctl --user is-active: active"],
    };
    mockInvoke.mockResolvedValueOnce(status);
    const result = await setupStatus();
    expect(mockInvoke).toHaveBeenCalledWith("setup_status");
    expect(result).toEqual(status);
  });
});

describe("setupInstallService", () => {
  it("calls invoke('setup_install_service') and resolves void", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await setupInstallService();
    expect(mockInvoke).toHaveBeenCalledWith("setup_install_service");
  });
});

describe("setupFixPermissions", () => {
  it("calls invoke('setup_fix_permissions') and returns PermissionFixOutcome", async () => {
    const outcome: PermissionFixOutcome = { relogin_needed: true };
    mockInvoke.mockResolvedValueOnce(outcome);
    const result = await setupFixPermissions();
    expect(mockInvoke).toHaveBeenCalledWith("setup_fix_permissions");
    expect(result.relogin_needed).toBe(true);
  });
});

describe("restartEngine", () => {
  it("calls invoke('restart_engine') and resolves void", async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    await restartEngine();
    expect(mockInvoke).toHaveBeenCalledWith("restart_engine");
  });
});

describe("collectReport", () => {
  it("calls invoke('collect_report') and returns string", async () => {
    const report = "== check ==\n{}\n\n== service ==\nactive\n\n";
    mockInvoke.mockResolvedValueOnce(report);
    const result = await collectReport();
    expect(mockInvoke).toHaveBeenCalledWith("collect_report");
    expect(result).toBe(report);
  });
});
