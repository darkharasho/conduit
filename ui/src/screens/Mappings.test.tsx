/**
 * Regression test for C1: verifies that MappingsScreen does NOT cause an
 * infinite IPC loop. getConfig must be called exactly once on mount — a
 * stable loadConfig + ref-held onProfilesChange must not re-trigger on
 * every render.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

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
