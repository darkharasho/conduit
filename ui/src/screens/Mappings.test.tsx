/**
 * Regression test for C1: verifies that MappingsScreen does NOT cause an
 * infinite IPC loop. getConfig must be called exactly once on mount — a
 * stable loadConfig + ref-held onProfilesChange must not re-trigger on
 * every render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act, screen, fireEvent, waitFor } from "@testing-library/react";

// ── Mock Tauri APIs before importing anything that uses them ──────────────────

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { MappingsScreen } from "./Mappings";
import { ConduitError } from "../lib/client";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

// Minimal valid TOML config
const MINIMAL_TOML = `
[profiles.default]
[profiles.default.layers.base]
`;

beforeEach(() => {
  vi.clearAllMocks();

  // getConfig returns the minimal TOML
  mockInvoke.mockResolvedValue(MINIMAL_TOML);

  // onConnection returns a stable unlisten pair
  const noopUnlisten = vi.fn();
  mockListen.mockResolvedValue(noopUnlisten);
});

describe("MappingsScreen — C1 render-loop regression", () => {
  it("calls getConfig exactly once on mount regardless of onProfilesChange identity", async () => {
    const onProfilesChange = vi.fn();

    // Render once
    await act(async () => {
      render(
        <MappingsScreen
          railActiveProfile="default"
          onProfilesChange={onProfilesChange}
        />
      );
    });

    // Give microtasks time to settle
    await act(async () => {
      await Promise.resolve();
    });

    const getConfigCalls = mockInvoke.mock.calls.filter(
      (args) => args[0] === "get_config"
    );

    expect(getConfigCalls).toHaveLength(1);
  });

  it("does not call getConfig again when the parent re-renders with a new onProfilesChange reference", async () => {
    // First render
    const { rerender } = await act(async () =>
      render(
        <MappingsScreen
          railActiveProfile="default"
          onProfilesChange={vi.fn()} // identity #1
        />
      )
    );

    await act(async () => { await Promise.resolve(); });

    const callsAfterMount = mockInvoke.mock.calls.filter(
      (args) => args[0] === "get_config"
    ).length;

    // Simulate parent re-render with a NEW inline arrow (was the bug)
    await act(async () => {
      rerender(
        <MappingsScreen
          railActiveProfile="default"
          onProfilesChange={vi.fn()} // identity #2 — new reference
        />
      );
    });

    await act(async () => { await Promise.resolve(); });

    const callsAfterRerender = mockInvoke.mock.calls.filter(
      (args) => args[0] === "get_config"
    ).length;

    // Should not have fired again
    expect(callsAfterRerender).toBe(callsAfterMount);
  });
});

describe("MappingsScreen — Detect button", () => {
  it("selects the first key pressed on the active device", async () => {
    const g502 = {
      path: "/dev/input/event11",
      name: "Logitech G502 X PLUS",
      vendor: 0x046d,
      product: 0x4099,
      is_keyboard: false,
      is_mouse: true,
      grabbed: true,
      id: "046d:4099/Logitech G502 X PLUS",
      class: "mouse",
      phys: "usb-1",
      keys: [0x110, 0x111, 0x112, 0x120],
      wheel: true,
      hwheel: true,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) =>
      cmd === "list_devices" ? [g502] : MINIMAL_TOML) as any);

    // Capture per-event listeners registered through the Tauri layer.
    const listeners = new Map<string, (e: { payload: unknown }) => void>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListen.mockImplementation((async (event: string, cb: (e: { payload: unknown }) => void) => {
      listeners.set(event, cb);
      return vi.fn();
    }) as any);

    const { findByText, container } = render(
      <MappingsScreen railActiveProfile="default" onProfilesChange={() => {}} />
    );

    const detectBtn = await findByText("Detect button");
    await act(async () => {
      detectBtn.click();
    });

    // Fire a press from the device through the event subscription.
    const eventCb = listeners.get("conduit://event");
    expect(eventCb).toBeDefined();
    await act(async () => {
      eventCb!({
        payload: {
          phase: "pre",
          key_name: "key:288",
          code: 288,
          state: "press",
          time_us: 1,
          device: "Logitech G502 X PLUS",
        },
      });
    });

    // The detected key chip is selected and the detect prompt is gone.
    const chip = container.querySelector('[data-key="key:288"]');
    expect(chip?.className).toContain("mousekey--sel");
    expect(container.textContent).toContain("Detect button");
    expect(container.textContent).not.toContain("press a button on");
  });
});

describe("MappingsScreen — focusDevicePath one-shot", () => {
  it("focuses the device tab once on load with focusDevicePath, and does not snap back on device list refresh", async () => {
    const mouse1 = {
      path: "/dev/input/event11",
      name: "Mouse 1",
      vendor: 0x046d,
      product: 0x4099,
      is_keyboard: false,
      is_mouse: true,
      grabbed: true,
      id: "046d:4099/Mouse1",
      class: "mouse",
      phys: "usb-1",
      keys: [],
      wheel: true,
      hwheel: true,
    };
    const mouse2 = {
      path: "/dev/input/event12",
      name: "Mouse 2",
      vendor: 0x046d,
      product: 0x409a,
      is_keyboard: false,
      is_mouse: true,
      grabbed: true,
      id: "046d:409a/Mouse2",
      class: "mouse",
      phys: "usb-2",
      keys: [],
      wheel: true,
      hwheel: true,
    };

    // Start with both devices, listen callback to trigger refresh.
    // onConnection() registers TWO listeners: "conduit://connected" (cb(true))
    // and "conduit://disconnected" (cb(false)).  We capture the connected one
    // so we can fire it to exercise the reload path.
    let connectedListenerCb: ((e: { payload: unknown }) => void) | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_config") return MINIMAL_TOML;
      if (cmd === "list_devices") return [mouse1, mouse2];
      return undefined;
    }) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListen.mockImplementation((async (event: string, cb: (e: { payload: unknown }) => void) => {
      if (event === "conduit://connected") {
        connectedListenerCb = cb;
      }
      return vi.fn();
    }) as any);

    // Render with focusDevicePath set to mouse2
    const { container } = render(
      <MappingsScreen
        railActiveProfile="default"
        onProfilesChange={() => {}}
        focusDevicePath="/dev/input/event12"
      />
    );

    // Wait for initial load
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Verify mouse2 tab is active (has aria-selected=true)
    // The device tabs container has role="tablist" aria-label="Devices"
    const deviceTabsContainer = container.querySelector('[role="tablist"][aria-label="Devices"]');
    expect(deviceTabsContainer).toBeTruthy();

    const allDeviceTabs = Array.from(deviceTabsContainer?.querySelectorAll('[role="tab"]') || []);
    const mouse2Tab = allDeviceTabs.find((btn) => btn.textContent?.includes("Mouse 2")) as HTMLButtonElement | undefined;
    expect(mouse2Tab).toBeTruthy();
    expect(mouse2Tab?.getAttribute("aria-selected")).toBe("true");

    // User manually switches to mouse1
    const mouse1Tab = allDeviceTabs.find((btn) => btn.textContent?.includes("Mouse 1")) as HTMLButtonElement | undefined;
    expect(mouse1Tab).toBeTruthy();
    await act(async () => { mouse1Tab?.click(); });

    // Verify mouse1 is now active
    expect(mouse1Tab?.getAttribute("aria-selected")).toBe("true");
    expect(mouse2Tab?.getAttribute("aria-selected")).toBe("false");

    // Simulate daemon reconnect by firing the "conduit://connected" Tauri event.
    // onConnection() wraps the user callback as `() => cb(true)`, so the
    // listener receives a raw Tauri event object (payload is null for these).
    // Firing it causes loadConfig() + loadDevices() to run a second time,
    // which is the reload path the guard must survive.
    expect(connectedListenerCb).not.toBeNull();
    await act(async () => {
      connectedListenerCb!({ payload: null });
      await Promise.resolve();
    });

    // Verify mouse1 is STILL active (tab does not snap back to mouse2)
    expect(mouse1Tab?.getAttribute("aria-selected")).toBe("true");
    expect(mouse2Tab?.getAttribute("aria-selected")).toBe("false");
  });
});

describe("MappingsScreen — plain-language assignment", () => {
  it("'Use default' removes the mapping and persists", async () => {
    const MAPPED_TOML = '[profile.default.keys]\na = "b"';
    const setConfigCalls: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string, args?: { toml?: string }) => {
      if (cmd === "get_config") return MAPPED_TOML;
      if (cmd === "list_devices") return [];
      if (cmd === "set_config") {
        setConfigCalls.push(args?.toml ?? "");
        return undefined;
      }
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    const { container, findByText } = render(
      <MappingsScreen railActiveProfile="default" onProfilesChange={() => {}} />
    );

    // Select the mapped key on the keyboard viz
    await act(async () => { await Promise.resolve(); });
    const keycap = container.querySelector('button[title="a"]') as HTMLElement;
    expect(keycap).toBeTruthy();
    await act(async () => { keycap.click(); });

    // Panel shows the plain state, then revert it
    const useDefault = await findByText("Use default");
    await act(async () => { useDefault.click(); });

    expect(setConfigCalls).toHaveLength(1);
    expect(setConfigCalls[0]).not.toContain('a = "b"');
  });
});

// A TOML config with key "a" mapped to "b" under profile "default" (base layer = profile.keys)
const MAPPED_TOML_AB = '[profile.default.keys]\na = "b"';

/** Shared arrange: render with a mapped config and no devices. */
async function renderMapped(invokeImpl: (cmd: string, args?: { toml?: string }) => unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockInvoke.mockImplementation((async (cmd: string, args?: { toml?: string }) =>
    invokeImpl(cmd, args)) as any);
  mockListen.mockResolvedValue(vi.fn());

  const result = render(
    <MappingsScreen railActiveProfile="default" onProfilesChange={() => {}} />,
  );

  // Wait for initial load
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });

  return result;
}

describe("MappingsScreen — applyWithUndo failure path", () => {
  it("apply failure reverts the model and offers Try again with plain language", async () => {
    let setConfigCallCount = 0;

    const { container, findByText } = await renderMapped((cmd, _args) => {
      if (cmd === "get_config") return MAPPED_TOML_AB;
      if (cmd === "list_devices") return [];
      if (cmd === "set_config") {
        setConfigCallCount++;
        if (setConfigCallCount === 1) {
          // First call rejects with a ConduitError (thrown synchronously from
          // the mock so the async wrapper rejects the promise)
          throw new ConduitError("config-invalid", "config rejected", "TOML parse error at line 3");
        }
        return undefined;
      }
      return undefined;
    });

    // Select the mapped key "a" on the keyboard viz
    const keycap = container.querySelector('button[title="a"]') as HTMLElement;
    expect(keycap).toBeTruthy();
    await act(async () => { keycap.click(); });

    // Wait for AssignPanel ("Use default" appears when panel is open)
    await findByText("Use default");

    // Click the "Back" quick pick to trigger a save that will fail
    const backBtn = await findByText("Back");
    await act(async () => { fireEvent.click(backBtn); });

    // Assert: error toast with plain-language title
    const toastEl = await screen.findByRole("status");
    expect(toastEl).toHaveTextContent("That change couldn't be applied");
    // Try again button is present
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // Raw error detail must NOT appear anywhere in the document
    expect(screen.queryByText(/line 3|TOML/)).toBeNull();
    // setConfig was called exactly once (no retry yet — optimistic model reverted)
    expect(setConfigCallCount).toBe(1);
  });
});

describe("MappingsScreen — applyWithUndo undo path", () => {
  it("undo re-applies the previous config", async () => {
    const setConfigCalls: string[] = [];

    const { container, findByText } = await renderMapped((cmd, args) => {
      if (cmd === "get_config") return MAPPED_TOML_AB;
      if (cmd === "list_devices") return [];
      if (cmd === "set_config") {
        setConfigCalls.push((args as { toml?: string })?.toml ?? "");
        return undefined;
      }
      return undefined;
    });

    // Select the mapped key "a" on the keyboard viz
    const keycap = container.querySelector('button[title="a"]') as HTMLElement;
    expect(keycap).toBeTruthy();
    await act(async () => { keycap.click(); });

    // Wait for AssignPanel, then click the "Back" quick pick to save
    await findByText("Use default");
    const backBtn = await findByText("Back");
    await act(async () => { fireEvent.click(backBtn); });

    // Wait for success toast with Undo button
    const undoBtn = await screen.findByRole("button", { name: "Undo" });
    expect(setConfigCalls).toHaveLength(1);
    // First setConfig call should include the new mapping
    expect(setConfigCalls[0]).toContain("back");

    // Click Undo — should re-apply the previous config (lacking the new mapping)
    await act(async () => { fireEvent.click(undoBtn); });

    // Second setConfig call must not contain the new mapping
    await waitFor(() => expect(setConfigCalls).toHaveLength(2));
    expect(setConfigCalls[1]).not.toContain("back");
  });
});
