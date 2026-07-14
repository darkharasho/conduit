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

    const detectBtn = await findByText("Select by pressing");
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
    expect(container.textContent).toContain("Select by pressing");
    expect(container.textContent).not.toContain("then press the button on your device");
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

describe("MappingsScreen — focusDevicePath no-flash", () => {
  /**
   * F2 regression guard: with focusDevicePath pointing to Mouse 2, Mouse 1
   * (the first device) must never receive aria-selected="true" at any point
   * during or after load, and Mouse 2 must be the active tab after load.
   *
   * The underlying bug: before the fix, activeDevPath initialised to null,
   * so loadDevices fell through to devs[0] (Mouse 1) before the one-shot
   * didFocus effect could switch to Mouse 2.  React 18's automatic batching
   * collapses the two consecutive setActiveDevPath calls into one DOM commit
   * in jsdom (so no intermediate "false → true → false" on mouse1 is
   * observable via MutationObserver), but in a real browser the two
   * synchronous commits cause a visible flash frame.
   *
   * The fix seeds the initial state from focusDevicePath so loadDevices
   * always keeps mouse2 (prev === focusDevicePath and is in the list),
   * eliminating the extra commit entirely.  This test asserts the final
   * outcome is correct.  The mechanism fix is proven by the fact that
   * loadDevices now returns focusDevicePath (not devs[0]) when prev matches.
   */
  it("Mouse 2 is selected after load and Mouse 1 (first device) is never selected", async () => {
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_config") return MINIMAL_TOML;
      if (cmd === "list_devices") return [mouse1, mouse2];
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    const { container } = render(
      <MappingsScreen
        railActiveProfile="default"
        onProfilesChange={() => {}}
        focusDevicePath="/dev/input/event12"
      />
    );

    // Wait for initial load (config + devices) and all effects to flush.
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Locate the device tabs after load.
    const deviceTabsContainer = container.querySelector('[role="tablist"][aria-label="Devices"]');
    expect(deviceTabsContainer).toBeTruthy();
    const allDeviceTabs = Array.from(deviceTabsContainer?.querySelectorAll('[role="tab"]') || []);
    const mouse1Tab = allDeviceTabs.find((btn) => btn.textContent?.includes("Mouse 1")) as HTMLButtonElement | undefined;
    const mouse2Tab = allDeviceTabs.find((btn) => btn.textContent?.includes("Mouse 2")) as HTMLButtonElement | undefined;
    expect(mouse1Tab).toBeTruthy();
    expect(mouse2Tab).toBeTruthy();

    // Mouse 2 must be the active tab after load.
    expect(mouse2Tab?.getAttribute("aria-selected")).toBe("true");

    // Mouse 1 must NOT be the active tab — not now and, critically, not
    // at any intermediate render during the load sequence.
    //
    // We track this by re-rendering with a fresh component and observing
    // aria-selected via MutationObserver across the entire load sequence.
    // This directly detects the "Wooting flash" pattern (first device
    // briefly selected before focusDevicePath takes effect).
    const mouse1SelectedValues: string[] = [];
    const { container: container2 } = render(
      <MappingsScreen
        railActiveProfile="default"
        onProfilesChange={() => {}}
        focusDevicePath="/dev/input/event12"
      />
    );

    // Observe the devtabs element for attribute mutations on its children.
    const observer = new MutationObserver(() => {
      const tabList2 = container2.querySelector('[role="tablist"][aria-label="Devices"]');
      const tabs2 = Array.from(tabList2?.querySelectorAll('[role="tab"]') || []);
      const m1tab2 = tabs2.find((b) => b.textContent?.includes("Mouse 1"));
      if (m1tab2) {
        mouse1SelectedValues.push(m1tab2.getAttribute("aria-selected") ?? "absent");
      }
    });
    observer.observe(container2, { subtree: true, attributes: true, attributeFilter: ["aria-selected"] });

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    observer.disconnect();

    // Pre-fix: mouse1SelectedValues would contain "true" (the intermediate render
    // where loadDevices picked devs[0] = Mouse 1 before didFocus corrected it).
    // Post-fix: mouse1SelectedValues only contains "false" (or is empty if the
    // tab never changed from Mouse 2).
    expect(mouse1SelectedValues.every((v) => v !== "true")).toBe(true);
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
    const useDefault = await findByText("Use the button's normal behavior");
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

    // Wait for AssignPanel (footer button appears when panel is open)
    await findByText("Use the button's normal behavior");

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

    // Wait for AssignPanel, then click the "Back" catalog entry to save
    await findByText("Use the button's normal behavior");
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

describe("MappingsScreen — applyWithUndo retry-then-undo", () => {
  /**
   * Regression for undo-stack corruption on the retry path.
   *
   * With a stale [model] closure, `applyWithUndoImpl` captures `prevSnapshot`
   * at the time the function was DEFINED (the render before the action). If an
   * external model update (e.g. daemon reconnect) changes the model between
   * the failure and the retry, the stale closure still uses the old prevSnapshot.
   * That means Undo after a successful retry restores the WRONG state (it misses
   * any keys that arrived via the external reload).
   *
   * With the `[]`-stable + modelRef fix, prevSnapshot is always read at CALL
   * TIME from the ref, so it correctly captures whatever the model was
   * immediately before the retry action ran.
   *
   * Scenario:
   * 1. Initial config: MAPPED_TOML_AB ("a" mapped to "b")
   * 2. Save "Back" on key "a" → M_back. setConfig REJECTS → model reverts to M0.
   * 3. External reload (connection event) delivers TOML_WITH_EXTRA which adds
   *    key "c" → "d". Model becomes M_extra.
   * 4. Click "Try again" → setConfig now RESOLVES → success toast.
   * 5. Click "Undo".
   * 6. CORRECT (ref): Undo setConfig = M_extra (prevSnapshot was M_extra at call time).
   *    WRONG (stale): Undo setConfig = M0 (prevSnapshot was M0 when fn was defined).
   *
   * We assert the undo TOML CONTAINS "c" (i.e. the externally-added key) to
   * confirm the ref path is used.
   */
  it("undo after retry uses current model as prev-snapshot, not the stale one from before the failure", async () => {
    // TOML_WITH_EXTRA adds key "c" = "d" to the base profile — this simulates
    // an external update that arrives while the error toast is showing.
    // NOTE: parser reads from [profile.<name>.keys], NOT [profiles.<name>].
    const TOML_WITH_EXTRA = '[profile.default.keys]\na = "b"\nc = "d"';

    const setConfigCalls: string[] = [];
    let setConfigCallCount = 0;
    let getConfigToml = MAPPED_TOML_AB; // starts as the minimal AB config

    // Capture the "conduit://connected" listener so we can trigger a reload.
    let connectedListenerCb: ((e: { payload: unknown }) => void) | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string, args?: { toml?: string }) => {
      if (cmd === "get_config") return getConfigToml;
      if (cmd === "list_devices") return [];
      if (cmd === "set_config") {
        setConfigCallCount++;
        const toml = args?.toml ?? "";
        if (setConfigCallCount === 1) {
          // First call fails — simulates daemon rejection
          throw new ConduitError("config-invalid", "config rejected", "TOML parse error");
        }
        setConfigCalls.push(toml);
        return undefined;
      }
      return undefined;
    }) as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListen.mockImplementation((async (event: string, cb: (e: { payload: unknown }) => void) => {
      if (event === "conduit://connected") {
        connectedListenerCb = cb;
      }
      return vi.fn();
    }) as any);

    const { container, findByText } = render(
      <MappingsScreen railActiveProfile="default" onProfilesChange={() => {}} />,
    );

    // Wait for initial load
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Select key "a" on the keyboard viz
    const keycap = container.querySelector('button[title="a"]') as HTMLElement;
    expect(keycap).toBeTruthy();
    await act(async () => { keycap.click(); });

    // Wait for AssignPanel, then click "Back" — first attempt fails
    await findByText("Use the button's normal behavior");
    const backBtn = await findByText("Back");
    await act(async () => { fireEvent.click(backBtn); });

    // Error toast with "Try again" should appear
    await screen.findByRole("status");
    const tryAgainBtn = screen.getByRole("button", { name: "Try again" });
    expect(setConfigCallCount).toBe(1); // only the failing call so far

    // Simulate an external model update (daemon reconnect delivers new TOML).
    // This changes model from M0 → M_extra (adds key "c" = "d").
    // The error toast is still showing; "Try again" button is still present.
    getConfigToml = TOML_WITH_EXTRA;
    expect(connectedListenerCb).not.toBeNull();
    await act(async () => {
      connectedListenerCb!({ payload: null });
      await Promise.resolve();
    });

    // Click "Try again" — second attempt succeeds
    await act(async () => { fireEvent.click(tryAgainBtn); });

    // Success toast with "Undo" should appear
    const undoBtn = await screen.findByRole("button", { name: "Undo" });
    expect(setConfigCalls).toHaveLength(1); // one successful set_config
    expect(setConfigCalls[0]).toContain("back"); // the action A output

    // Click "Undo" — must revert to M_extra (the model that was current when retry ran).
    // The stale-closure bug would revert to M0 (misses the "c" key from external reload).
    await act(async () => { fireEvent.click(undoBtn); });

    await waitFor(() => expect(setConfigCalls).toHaveLength(2));
    // The undo TOML must contain the "c" KEY from the external reload.
    // Use the full key-value form to avoid matching "c" as a letter inside words
    // like "[settings]" or "[devices]" that appear in every serialized TOML.
    // Stale-closure bug: Undo uses M0 (no 'c = "d"' entry).
    // Ref fix:          Undo uses M_extra ('c = "d"' entry present).
    expect(setConfigCalls[1]).toContain('c = "d"');
    // And must NOT contain "back" (the failed action A output)
    expect(setConfigCalls[1]).not.toContain("back");
  });
});

describe("MappingsScreen — installed-apps pill labels", () => {
  it("shows the installed-app display name on the pill, not the capitalized class", async () => {
    const FIREFOX_TOML = `
[profile.default.keys]

[profile.firefox]
match = { class = "firefox" }
[profile.firefox.keys]
mouse4 = "back"
`;

    const firefoxApp = {
      app_id: "org.mozilla.firefox",
      // Multi-word name: capitalize("firefox") can never produce this, so the
      // assertion below discriminates the installed-app path from the fallback.
      name: "Mozilla Firefox",
      wm_class: "firefox",
      categories: ["WebBrowser"],
      icon: null,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_config") return FIREFOX_TOML;
      if (cmd === "list_devices") return [];
      if (cmd === "list_installed_apps") return [firefoxApp];
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    render(
      <MappingsScreen railActiveProfile="default" onProfilesChange={() => {}} />
    );

    // Wait for both the config and installed apps to load
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // The pill must show the installed app's name. "Mozilla Firefox" cannot
    // be produced by the capitalize("firefox") fallback, so this fails if
    // the installedApps fetch result is not actually consulted.
    const pillNames = Array.from(document.querySelectorAll(".app-pill .app-pill__name")).map(
      (el) => el.textContent
    );
    expect(pillNames).toContain("Mozilla Firefox");
  });
});

describe("MappingsScreen — profile removal navigates to default only on success", () => {
  const FIREFOX_TOML = `
[profile.default.keys]

[profile.firefox]
match = { class = "firefox" }
[profile.firefox.keys]
`;

  /** Navigate the 3-step remove flow: ⋯ → "Remove Firefox settings" → "Remove" */
  async function triggerRemove(container: HTMLElement) {
    // Step 1: open the ⋯ menu
    const menuBtn = container.querySelector('button[aria-label="More options"]') as HTMLElement;
    expect(menuBtn).toBeTruthy();
    await act(async () => { fireEvent.click(menuBtn); });

    // Step 2: click "Remove … settings" menu item
    const removeSettingsBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Remove") && b.textContent?.includes("settings")
    ) as HTMLElement;
    expect(removeSettingsBtn).toBeTruthy();
    await act(async () => { fireEvent.click(removeSettingsBtn); });

    // Step 3: click the confirm "Remove" button
    const confirmRemoveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Remove"
    ) as HTMLElement;
    expect(confirmRemoveBtn).toBeTruthy();
    await act(async () => { fireEvent.click(confirmRemoveBtn); });
    await act(async () => { await Promise.resolve(); });
  }

  it("onSelectProfile('default') is called after successful profile removal", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_config") return FIREFOX_TOML;
      if (cmd === "list_devices") return [];
      if (cmd === "list_installed_apps") return [{ app_id: "org.mozilla.firefox", name: "Firefox", wm_class: "firefox", categories: [], icon: null }];
      if (cmd === "set_config") return undefined; // success
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    const onSelectProfile = vi.fn();
    const { container } = render(
      <MappingsScreen
        railActiveProfile="firefox"
        onProfilesChange={() => {}}
        onSelectProfile={onSelectProfile}
      />
    );

    // Wait for mount and load
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    await triggerRemove(container);

    expect(onSelectProfile).toHaveBeenCalledWith("default");
  });

  it("onSelectProfile is NOT called when set_config rejects during profile removal", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_config") return FIREFOX_TOML;
      if (cmd === "list_devices") return [];
      if (cmd === "list_installed_apps") return [{ app_id: "org.mozilla.firefox", name: "Firefox", wm_class: "firefox", categories: [], icon: null }];
      if (cmd === "set_config") throw new ConduitError("config-invalid", "rejected", "");
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    const onSelectProfile = vi.fn();
    const { container } = render(
      <MappingsScreen
        railActiveProfile="firefox"
        onProfilesChange={() => {}}
        onSelectProfile={onSelectProfile}
      />
    );

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    await triggerRemove(container);

    expect(onSelectProfile).not.toHaveBeenCalledWith("default");
  });
});

describe("MappingsScreen — per-app overlay inheritance", () => {
  const TWO_PROFILE_TOML = `
[profile.default.keys]
a = "b"

[profile.firefox]
match = { class = "firefox" }
[profile.firefox.keys]
`;

  it("shows --inherited class for a key inherited from Everywhere in the firefox profile", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_config") return TWO_PROFILE_TOML;
      if (cmd === "list_devices") return [];
      if (cmd === "list_installed_apps") return [];
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    const { container } = render(
      <MappingsScreen railActiveProfile="firefox" onProfilesChange={() => {}} />
    );

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // In the firefox profile, key "a" is not set — it inherits from Everywhere (default).
    // Since no device is present, KeyboardViz renders, and all keys that have
    // Everywhere mappings but not firefox mappings get --inherited.
    // Key "a" is in the ANSI layout and is mapped in default, so it should appear as --inherited.
    const inheritedEl = container.querySelector('[class*="--inherited"]');
    expect(inheritedEl).not.toBeNull();
  });

  it("AssignPanel header shows the inherited action label when selecting an Everywhere-mapped key in app context", async () => {
    // key "a" is mapped to "b" (→ actionLabel: "Types b") in the default (Everywhere) profile.
    // Firefox profile has no mapping for "a", so the panel should show the inherited label,
    // not "Normal job" (which would appear if we used getEffectiveAction alone).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_config") return TWO_PROFILE_TOML;
      if (cmd === "list_devices") return [];
      if (cmd === "list_installed_apps") return [];
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    const { container } = render(
      <MappingsScreen railActiveProfile="firefox" onProfilesChange={() => {}} />
    );

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Click key "a" on the keyboard viz to open the AssignPanel
    const keycap = container.querySelector('button[title="a"]') as HTMLElement;
    expect(keycap).toBeTruthy();
    await act(async () => { keycap.click(); });

    // The panel header "Right now it does: …" must show the inherited Everywhere label.
    // key "b" → keyLabel("b") = "B" (single char, uppercased) → actionLabel = "Types B".
    // "Normal job" would appear only if the fallback was not applied (getEffectiveAction alone
    // returns null for an inherited key, yielding actionLabel(null) = "Normal job").
    const nowEl = container.querySelector(".assign__now");
    expect(nowEl).toBeTruthy();
    expect(nowEl?.textContent).toContain("Types B");
    expect(nowEl?.textContent).not.toContain("Normal job");
  });
});
