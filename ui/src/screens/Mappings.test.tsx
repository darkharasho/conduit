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

describe("MappingsScreen — single-device mode (focusDevicePath)", () => {
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
  const keyboard1 = {
    path: "/dev/input/event5",
    name: "Keyboard 1",
    vendor: 0x1234,
    product: 0x5678,
    is_keyboard: true,
    is_mouse: false,
    grabbed: true,
    id: "1234:5678/Keyboard1",
    class: "keyboard",
    phys: "usb-2",
    keys: [],
    wheel: false,
    hwheel: false,
  };

  it("(a) renders ONLY the focus device — the other device's name is not in the document", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_config") return MINIMAL_TOML;
      if (cmd === "list_devices") return [mouse1, keyboard1];
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    render(
      <MappingsScreen
        railActiveProfile="default"
        onProfilesChange={() => {}}
        focusDevicePath="/dev/input/event11"
      />
    );

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // No tab strip should exist at all
    expect(document.querySelector('[role="tablist"][aria-label="Devices"]')).toBeNull();
    // The other device's name must not appear anywhere
    expect(document.body.textContent).not.toContain("Keyboard 1");
  });

  it("(b) unplug flow: device list reload without focus device shows disconnect message and Back button calls onBack", async () => {
    let connectedListenerCb: ((e: { payload: unknown }) => void) | null = null;
    let devicesInList = [mouse1];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_config") return MINIMAL_TOML;
      if (cmd === "list_devices") return devicesInList;
      return undefined;
    }) as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListen.mockImplementation((async (event: string, cb: (e: { payload: unknown }) => void) => {
      if (event === "conduit://connected") connectedListenerCb = cb;
      return vi.fn();
    }) as any);

    const onBack = vi.fn();
    render(
      <MappingsScreen
        railActiveProfile="default"
        onProfilesChange={() => {}}
        focusDevicePath="/dev/input/event11"
        onBack={onBack}
      />
    );

    // Initial load — device is present, no disconnect message
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(document.body.textContent).not.toContain("isn't connected anymore");

    // Simulate device unplug: device list no longer contains the focus device
    devicesInList = [];
    expect(connectedListenerCb).not.toBeNull();
    await act(async () => {
      connectedListenerCb!({ payload: null });
      await Promise.resolve();
    });
    await act(async () => { await Promise.resolve(); });

    // Disconnect message should appear
    expect(document.body.textContent).toContain("isn't connected anymore");
    // Find the "Back to your devices" button
    const allBtns = Array.from(document.querySelectorAll('button'));
    const backToDevices = allBtns.find((b) => b.textContent?.includes("Back to your devices"));
    expect(backToDevices).toBeTruthy();
    await act(async () => { backToDevices!.click(); });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("(c) no-focusDevicePath fallback renders first device without a tab strip", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_config") return MINIMAL_TOML;
      if (cmd === "list_devices") return [mouse1, keyboard1];
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    render(
      <MappingsScreen
        railActiveProfile="default"
        onProfilesChange={() => {}}
        // No focusDevicePath — fallback to first device
      />
    );

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // No tab strip
    expect(document.querySelector('[role="tablist"][aria-label="Devices"]')).toBeNull();
    // "Select by pressing" button should appear (first device is active)
    expect(document.body.textContent).toContain("Select by pressing");
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

describe("MappingsScreen — advanced picker plumbing", () => {
  it("isBrowser is passed to appContext for a browser pill", async () => {
    const FIREFOX_TOML = `
[profile.default.keys]

[profile.firefox]
match = { class = "firefox" }
[profile.firefox.keys]
`;
    const firefoxApp = {
      app_id: "org.mozilla.firefox",
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
      if (cmd === "list_windows") return [];
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    const { container } = render(
      <MappingsScreen railActiveProfile="firefox" onProfilesChange={() => {}} />
    );

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Click key "a" to open AssignPanel with app context
    const keycap = container.querySelector('button[title="a"]') as HTMLElement;
    expect(keycap).toBeTruthy();
    await act(async () => { keycap.click(); });

    // In browser context, the Popular list should show "Back" before "Copy".
    // "Back" is browser-first; "Copy" is a regular popular shortcut.
    await screen.findByText("In Mozilla Firefox");
    const rows = Array.from(container.querySelectorAll(".cat-row__label")).map((el) => el.textContent ?? "");
    const backIdx = rows.findIndex((l) => l === "Back");
    const copyIdx = rows.findIndex((l) => l === "Copy");
    expect(backIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(backIdx).toBeLessThan(copyIdx);
  });

  it("handlePickAdvanced creates profile with title-only matcher via setProfileMatch", async () => {
    const EMPTY_TOML = '[profile.default.keys]\n';
    const setConfigCalls: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string, args?: { toml?: string }) => {
      if (cmd === "get_config") return EMPTY_TOML;
      if (cmd === "list_devices") return [];
      if (cmd === "list_installed_apps") return [];
      if (cmd === "list_windows") return [];
      if (cmd === "set_config") {
        setConfigCalls.push(args?.toml ?? "");
        return undefined;
      }
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    const onSelectProfile = vi.fn();
    const { container } = render(
      <MappingsScreen railActiveProfile="default" onProfilesChange={() => {}} onSelectProfile={onSelectProfile} />
    );

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Open the app picker
    const addBtn = container.querySelector('.app-pill--add') as HTMLElement;
    expect(addBtn).toBeTruthy();
    await act(async () => { fireEvent.click(addBtn); });

    // The picker must be open — find the Advanced link
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Advanced: match a specific window/i })).toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: /Advanced: match a specific window/i }));

    // Fill in title only
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "GitHub" } });
    fireEvent.change(screen.getByLabelText("Title pattern"), { target: { value: "GitHub" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Create" })); });
    await act(async () => { await Promise.resolve(); });

    // setConfig must have been called
    expect(setConfigCalls).toHaveLength(1);
    // The serialised TOML must contain the title match (and must NOT contain a class match for empty class)
    expect(setConfigCalls[0]).toContain("GitHub");
    expect(onSelectProfile).toHaveBeenCalledWith("github");
  });
});

// ─── Finding 2a+2b: "Some buttons missing?" link visibility ─────────────────
//
// The link must appear for pointer-class devices (mouse/touchpad) and must NOT
// appear for keyboard-class devices.  Finding 2c (onFix gating) is covered
// in ButtonCheck.test.tsx via props because triggering the modal and inspecting
// ButtonCheck's internal prop wiring from MappingsScreen is impractical here.

describe('MappingsScreen — "Some buttons missing?" link', () => {
  const pointerDevice = {
    path: "/dev/input/event11",
    name: "Logitech G502 X PLUS",
    vendor: 0x046d,
    product: 0x4099,
    is_keyboard: false,
    is_mouse: true,
    grabbed: true,
    id: "046d:4099/G502X",
    class: "mouse",
    phys: "usb-1",
    keys: [0x110, 0x111],
    wheel: true,
    hwheel: true,
  };

  const keyboardDevice = {
    path: "/dev/input/event5",
    name: "Das Keyboard",
    vendor: 0x1234,
    product: 0x5678,
    is_keyboard: true,
    is_mouse: false,
    grabbed: true,
    id: "1234:5678/DasKeyboard",
    class: "keyboard",
    phys: "usb-2",
    keys: [],
    wheel: false,
    hwheel: false,
  };

  it('(a) renders "Some buttons missing?" for a pointer-class device', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_config") return MINIMAL_TOML;
      if (cmd === "list_devices") return [pointerDevice];
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    render(
      <MappingsScreen railActiveProfile="default" onProfilesChange={() => {}} />
    );

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(document.body.textContent).toContain("Some buttons missing?");
  });

  it('(b) does NOT render "Some buttons missing?" for a keyboard-class device', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "get_config") return MINIMAL_TOML;
      if (cmd === "list_devices") return [keyboardDevice];
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    render(
      <MappingsScreen railActiveProfile="default" onProfilesChange={() => {}} />
    );

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    expect(document.body.textContent).not.toContain("Some buttons missing?");
  });
});

describe("phase 6 nits", () => {
  it("item 4: handleUseDefault no-ops when key has no mapping (setConfig NOT called)", async () => {
    // Config with no mapping on key "q" — clicking "Use default" on "q" should be a no-op
    const EMPTY_TOML = '[profile.default.keys]\n';
    const setConfigCalls: string[] = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string, args?: { toml?: string }) => {
      if (cmd === "get_config") return EMPTY_TOML;
      if (cmd === "list_devices") return [];
      if (cmd === "list_installed_apps") return [];
      if (cmd === "set_config") {
        setConfigCalls.push(args?.toml ?? "");
        return undefined;
      }
      return undefined;
    }) as any);
    mockListen.mockResolvedValue(vi.fn());

    const { container } = render(
      <MappingsScreen railActiveProfile="default" onProfilesChange={() => {}} />
    );

    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });

    // Click key "q" — it has no mapping
    const keycapQ = container.querySelector('button[title="q"]') as HTMLElement;
    expect(keycapQ).toBeTruthy();
    await act(async () => { keycapQ.click(); });

    // Click "Use the button's normal behavior" (handleUseDefault)
    const useDefaultBtn = await screen.findByText("Use the button's normal behavior");
    await act(async () => { useDefaultBtn.click(); });

    // setConfig must NOT have been called (no mapping existed, so no-op)
    expect(setConfigCalls).toHaveLength(0);
  });
});
