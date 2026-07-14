/**
 * ButtonCheck component tests — Task 4 + Task 6 (fix wizard).
 *
 * Tests are written first (failing); implementation follows.
 *
 * Mocking convention: vi.mock("../lib/client") before importing the component.
 * The onKeyEvent function returns a Promise<() => void> (unlisten handle).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

// ── Mock Tauri APIs before importing anything that uses them ──────────────────

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const mockInvoke = vi.mocked(invoke);

const mockListen = vi.mocked(listen);

// Re-export the listen mock through client's onKeyEvent
// ButtonCheck imports onKeyEvent from client; client calls listen internally.

import { ButtonCheck } from "./ButtonCheck";
import type { DeviceInfo } from "../lib/client";

// ─── Shared device fixtures ──────────────────────────────────────────────────

/** G502 X PLUS — curated fixable device */
const G502X: DeviceInfo = {
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

/** Generic mouse — not in the curated fixable set */
const GENERIC_MOUSE: DeviceInfo = {
  path: "/dev/input/event5",
  name: "Generic Mouse",
  vendor: 0x1234,
  product: 0x5678,
  is_keyboard: false,
  is_mouse: true,
  grabbed: true,
  id: "1234:5678/Generic Mouse",
  class: "mouse",
  phys: "usb-2",
  keys: [0x110, 0x111],
  wheel: false,
  hwheel: false,
};

// Helper: capture the onKeyEvent listener registered by the component
// ButtonCheck uses onKeyEvent which calls listen("conduit://event", cb)
type KeyEventCb = (e: { payload: unknown }) => void;

function setupListenMock(): { getEventCb: () => KeyEventCb | undefined; getUnlistenMock: () => ReturnType<typeof vi.fn> | undefined } {
  let eventCb: KeyEventCb | undefined;
  let unlistenMock: ReturnType<typeof vi.fn> | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockListen.mockImplementation(async (event: string, cb: any) => {
    if (event === "conduit://event") {
      eventCb = cb as KeyEventCb;
      unlistenMock = vi.fn();
      return unlistenMock;
    }
    return vi.fn();
  });
  return { getEventCb: () => eventCb, getUnlistenMock: () => unlistenMock };
}

// Helper: fire a key event through the captured listener
async function fireKeyEvent(cb: KeyEventCb, keyName: string, code: number, deviceName: string) {
  await act(async () => {
    cb({
      payload: {
        phase: "pre",
        key_name: keyName,
        code,
        state: "press",
        time_us: Date.now() * 1000,
        device: deviceName,
      },
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: listen returns a noop unlisten
  mockListen.mockResolvedValue(vi.fn());
});

// Restore real timers after every test, even if the test threw.
// This guards against fake-timer leakage into unrelated tests — the project
// has been bitten by this before (see memory/subagent-git-guardrails notes).
afterEach(() => {
  vi.useRealTimers();
});

// ─── Render tests ────────────────────────────────────────────────────────────

describe("ButtonCheck — initial render", () => {
  it("shows the intro sentence with the device name", () => {
    render(<ButtonCheck device={G502X} onClose={() => {}} />);
    expect(screen.getByText(/Press each button on your Logitech G502 X PLUS once/)).toBeInTheDocument();
  });

  it("shows the live tally starting at 0 signals and 0 presses", () => {
    render(<ButtonCheck device={G502X} onClose={() => {}} />);
    expect(screen.getByText(/0 signals seen/)).toBeInTheDocument();
    expect(screen.getByText(/0 presses/)).toBeInTheDocument();
  });

  it("renders a Done button", () => {
    render(<ButtonCheck device={G502X} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("does not show a verdict before Done is clicked", () => {
    render(<ButtonCheck device={G502X} onClose={() => {}} />);
    expect(screen.queryByText(/All.*buttons send distinct signals/)).toBeNull();
    expect(screen.queryByText(/share signals/)).toBeNull();
  });
});

// ─── Event accumulation and tally ───────────────────────────────────────────

describe("ButtonCheck — live tally", () => {
  it("increments signal and press counts as events arrive", async () => {
    const { getEventCb } = setupListenMock();

    render(<ButtonCheck device={G502X} onClose={() => {}} />);

    const cb = getEventCb();
    expect(cb).toBeDefined();

    // Fire button 1 (BTN_LEFT = 0x110)
    await fireKeyEvent(cb!, "key:272", 0x110, "Logitech G502 X PLUS");
    expect(screen.getByText(/1 signals seen/)).toBeInTheDocument();
    expect(screen.getByText(/1 presses/)).toBeInTheDocument();

    // Fire button 2 (BTN_RIGHT = 0x111) — new distinct signal
    await fireKeyEvent(cb!, "key:273", 0x111, "Logitech G502 X PLUS");
    expect(screen.getByText(/2 signals seen/)).toBeInTheDocument();
    expect(screen.getByText(/2 presses/)).toBeInTheDocument();
  });

  it("ignores events from other devices", async () => {
    const { getEventCb } = setupListenMock();

    render(<ButtonCheck device={G502X} onClose={() => {}} />);

    const cb = getEventCb();
    expect(cb).toBeDefined();

    // Fire event from a different device
    await fireKeyEvent(cb!, "key:272", 0x110, "Some Other Mouse");

    // Should still show 0 — ignored
    expect(screen.getByText(/0 signals seen/)).toBeInTheDocument();
  });

  it("ignores post-phase events", async () => {
    const { getEventCb } = setupListenMock();

    render(<ButtonCheck device={G502X} onClose={() => {}} />);

    const cb = getEventCb();
    expect(cb).toBeDefined();

    await act(async () => {
      cb!({
        payload: {
          phase: "post",
          key_name: "key:272",
          code: 0x110,
          state: "press",
          time_us: 1,
          device: "Logitech G502 X PLUS",
        },
      });
    });

    expect(screen.getByText(/0 signals seen/)).toBeInTheDocument();
  });
});

// ─── Done → no-collision verdict ────────────────────────────────────────────

describe("ButtonCheck — Done button, no collisions", () => {
  it("shows all-clear verdict when all signals are distinct", async () => {
    const { getEventCb } = setupListenMock();

    render(<ButtonCheck device={G502X} onClose={() => {}} />);

    const cb = getEventCb()!;

    // Press three distinct buttons
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:274", 0x112, "Logitech G502 X PLUS");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });

    expect(screen.getByText("All 3 buttons send distinct signals. You're all set.")).toBeInTheDocument();
  });
});

// ─── Done → collision verdict, curated device (onFix provided) ───────────────

describe("ButtonCheck — Done button, collisions, curated device", () => {
  it("shows collision verdict with exact copy when two buttons share a signal", async () => {
    const { getEventCb } = setupListenMock();
    const onFix = vi.fn();

    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={onFix} />);

    const cb = getEventCb()!;

    // Three presses: button 1, button 2, button 1 again (collision on 0x110)
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });

    // Exact collision verdict copy required by spec
    expect(
      screen.getByText(
        "1 of this mouse's buttons share signals, so Conduit can't tell them apart. This is stored in the mouse itself."
      )
    ).toBeInTheDocument();
  });

  it("shows 'Fix this mouse's memory' button when onFix is provided (curated device)", async () => {
    // Provide a ratbag_status mock so the wizard can proceed past status check
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "ratbag_status") {
        return { daemon_running: true, device_id: "usb_046d_c099_if01", device_name: "Logitech G502 X PLUS" };
      }
      if (cmd === "ratbag_read_buttons") {
        return [{ index: 0, action: "button 1", human: "Left click" }];
      }
      if (cmd === "ratbag_suggest_rewrites") {
        return [];
      }
      return undefined;
    });

    const { getEventCb } = setupListenMock();
    const onFix = vi.fn();

    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={onFix} />);

    const cb = getEventCb()!;

    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });

    const fixBtn = screen.getByRole("button", { name: "Fix this mouse's memory" });
    expect(fixBtn).toBeInTheDocument();

    // Clicking the fix button now starts the internal wizard (not calls onFix directly).
    // The onFix prop gates whether the button appears; the wizard replaces the panel.
    await act(async () => { fireEvent.click(fixBtn); });
    // Wizard should have started — panel content should no longer be the collision verdict
    await waitFor(() => {
      // Either in preparing/reading state or confirm sheet
      const body = document.body.textContent ?? "";
      expect(body).toMatch(/Preparing|Reading|will send its own signal|Rewrite/i);
    });
  });
});

// ─── Done → collision verdict, non-curated device (no onFix) ─────────────────

describe("ButtonCheck — Done button, collisions, non-curated device", () => {
  it("shows 'can't fix automatically yet' copy when onFix is absent", async () => {
    const { getEventCb } = setupListenMock();

    // No onFix prop — generic mouse
    render(<ButtonCheck device={GENERIC_MOUSE} onClose={() => {}} />);

    const cb = getEventCb()!;

    await fireKeyEvent(cb, "key:272", 0x110, "Generic Mouse");
    await fireKeyEvent(cb, "key:273", 0x111, "Generic Mouse");
    await fireKeyEvent(cb, "key:272", 0x110, "Generic Mouse");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });

    expect(screen.getByText("Conduit can't fix this mouse automatically yet.")).toBeInTheDocument();
    // Fix button must NOT appear
    expect(screen.queryByRole("button", { name: "Fix this mouse's memory" })).toBeNull();
  });
});

// ─── Technical details pane — jargon quarantine ──────────────────────────────

describe("ButtonCheck — technical details pane", () => {
  it("technical details pane is hidden before clicking 'Show technical details'", async () => {
    const { getEventCb } = setupListenMock();
    const onFix = vi.fn();

    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={onFix} />);

    const cb = getEventCb()!;

    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });

    // Technical details should be hidden
    expect(screen.queryByText("Show technical details")).toBeInTheDocument();
    // Raw codes must NOT be visible (quarantined)
    expect(screen.queryByText(/0x110/)).toBeNull();
    expect(screen.queryByText(/272/)).toBeNull();
  });

  it("technical details pane shows raw code map after clicking 'Show technical details'", async () => {
    const { getEventCb } = setupListenMock();
    const onFix = vi.fn();

    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={onFix} />);

    const cb = getEventCb()!;

    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });

    // Click show technical details
    await act(async () => {
      fireEvent.click(screen.getByText("Show technical details"));
    });

    // Now codes should be visible (multiple cells may match the regex)
    expect(screen.getAllByText(/272|0x110/).length).toBeGreaterThan(0);
  });

  it("jargon terms are NOT visible before clicking technical details", async () => {
    const { getEventCb } = setupListenMock();

    render(<ButtonCheck device={G502X} onClose={() => {}} />);

    const cb = getEventCb()!;

    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });

    const bodyText = document.body.textContent ?? "";
    // Full banned-jargon list: none of these must appear in screen text outside the technical pane
    expect(bodyText).not.toMatch(/\bdaemon\b/i);
    expect(bodyText).not.toMatch(/\bsocket\b/i);
    expect(bodyText).not.toMatch(/\buinput\b/i);
    expect(bodyText).not.toMatch(/\budev\b/i);
    expect(bodyText).not.toMatch(/\bsystemd\b/i);
    expect(bodyText).not.toMatch(/\bpolkit\b/i);
    expect(bodyText).not.toMatch(/ratbagd/);
    expect(bodyText).not.toMatch(/HID\+\+/);
    expect(bodyText).not.toMatch(/KEY_/);
    // Numeric codes should not appear outside technical pane
    // (test indirectly: 0x110 = 272 decimal — check 272 not in body text)
    expect(bodyText).not.toMatch(/\b272\b/);
    expect(bodyText).not.toMatch(/\b0x110\b/);
  });
});

// ─── isOnboardFixable export ─────────────────────────────────────────────────

describe("isOnboardFixable", () => {
  it("returns true for G502 X PLUS (046d:4099)", async () => {
    const { isOnboardFixable } = await import("./ButtonCheck");
    expect(isOnboardFixable(G502X)).toBe(true);
  });

  it("returns true for 046d:c099", async () => {
    const { isOnboardFixable } = await import("./ButtonCheck");
    const dev = { ...G502X, product: 0xc099 };
    expect(isOnboardFixable(dev)).toBe(true);
  });

  it("returns true for 046d:c095", async () => {
    const { isOnboardFixable } = await import("./ButtonCheck");
    const dev = { ...G502X, product: 0xc095 };
    expect(isOnboardFixable(dev)).toBe(true);
  });

  it("returns false for a non-Logitech device", async () => {
    const { isOnboardFixable } = await import("./ButtonCheck");
    expect(isOnboardFixable(GENERIC_MOUSE)).toBe(false);
  });

  it("returns false for a different Logitech product not in the fixable set", async () => {
    const { isOnboardFixable } = await import("./ButtonCheck");
    const dev = { ...G502X, product: 0x101a };
    expect(isOnboardFixable(dev)).toBe(false);
  });
});

// ─── Unmount cleanup ─────────────────────────────────────────────────────────
//
// Verifies that the effect cleanup calls the unlisten handle returned by the
// `listen` subscription so that the Tauri event listener is torn down when the
// component unmounts.
//
// Bite-proof note (Finding 1): temporarily commenting out `if (unlisten) unlisten();`
// and `else sub.then((fn) => fn());` in ButtonCheck.tsx lines 81-82 caused this
// test to fail with:
//   AssertionError: expected "spy" to have been called at least once, but it was never called
// Restoring those lines made the test pass again (see fix-report below).

describe("ButtonCheck — unmount cleanup", () => {
  it("calls the unlisten handle when the component unmounts", async () => {
    const { getUnlistenMock } = setupListenMock();

    // Render the component — this triggers the useEffect which calls listen()
    const { unmount } = render(<ButtonCheck device={G502X} onClose={() => {}} />);

    // Allow the listen() promise to resolve so unlisten is captured inside the effect
    await act(async () => {
      await Promise.resolve();
    });

    // Confirm the mock is defined (listen was called for conduit://event)
    const unlistenMock = getUnlistenMock();
    expect(unlistenMock).toBeDefined();
    expect(unlistenMock).not.toHaveBeenCalled();

    // Unmount — the effect cleanup should call unlisten()
    await act(async () => {
      unmount();
    });

    // The unlisten handle must have been called exactly once
    expect(unlistenMock).toHaveBeenCalledTimes(1);
  });
});

// ─── onFix gating (Finding 2c, covered here since Mappings panel interaction
//     is impractical at the integration level) ─────────────────────────────────
//
// For a fixable device (vendor 0x046d, product 0x4099) the ButtonCheck panel
// receives onFix and shows "Fix this mouse's memory" after a collision.
// For a non-fixable collided mouse it does not — no fix button appears.

describe("ButtonCheck — onFix gating via props", () => {
  it("(fixable device) shows 'Fix this mouse's memory' when onFix is provided", async () => {
    const { getEventCb } = setupListenMock();
    const onFix = vi.fn();

    // G502X is the fixable device; caller (Mappings) would pass onFix only when isOnboardFixable is true
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={onFix} />);

    const cb = getEventCb()!;
    // Generate a collision: same code pressed twice
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });

    // Fix button must appear for fixable device
    expect(screen.getByRole("button", { name: "Fix this mouse's memory" })).toBeInTheDocument();
    // "can't fix automatically" must NOT appear
    expect(screen.queryByText(/can't fix this mouse automatically yet/)).toBeNull();
  });

  it("(non-fixable device) does NOT show fix button when onFix is absent", async () => {
    const { getEventCb } = setupListenMock();

    // GENERIC_MOUSE is not in the fixable set; caller would omit onFix
    render(<ButtonCheck device={GENERIC_MOUSE} onClose={() => {}} />);

    const cb = getEventCb()!;
    await fireKeyEvent(cb, "key:272", 0x110, "Generic Mouse");
    await fireKeyEvent(cb, "key:273", 0x111, "Generic Mouse");
    await fireKeyEvent(cb, "key:272", 0x110, "Generic Mouse");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
    });

    // Fix button must NOT appear for non-fixable device
    expect(screen.queryByRole("button", { name: "Fix this mouse's memory" })).toBeNull();
    // "can't fix automatically" must appear
    expect(screen.getByText("Conduit can't fix this mouse automatically yet.")).toBeInTheDocument();
  });
});

// Note: @testing-library/react runs cleanup() automatically via afterEach — no manual call needed.

// ─── Task 6: Fix wizard tests ─────────────────────────────────────────────────
//
// These tests validate the onboard fix wizard that appears when the user clicks
// "Fix this mouse's memory" in the collision verdict. All ratbag client calls
// are mocked via vi.mocked(invoke).
//
// Wizard flow:
//   1. ratbag_status() — if device missing, show preparing text
//      → ratbag_stage_device_file() → ratbag_fix_setup(path) → re-status poll
//   2. ratbag_read_buttons → confirm sheet
//   3. ratbag_rewrite → success → auto re-run press-check phase

/** Standard happy-path mock setup for the ratbag commands. */
function setupRatbagHappyPath() {
  // ratbag_status: device is already known to ratbagd
  // ratbag_read_buttons: return two buttons where index 3 maps to the same
  //   signal as index 0 (a collision), so suggestRewrites returns one target
  // ratbag_suggest_rewrites: index 3 → KEY_F13
  // ratbag_rewrite: void success
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockInvoke.mockImplementation((async (cmd: string) => {
    switch (cmd) {
      case "ratbag_status":
        return {
          daemon_running: true,
          device_id: "usb_046d_c099_if01",
          device_name: "Logitech G502 X PLUS",
        };
      case "ratbag_read_buttons":
        return [
          { index: 0, action: "button 1", human: "Left click" },
          { index: 3, action: "button 1", human: "Left click" },
        ] satisfies { index: number; action: string; human: string }[];
      case "ratbag_suggest_rewrites":
        return [[3, "macro +KEY_F13 -KEY_F13"]] as [number, string][];
      case "ratbag_rewrite":
        return undefined;
      // Default: anything from beforeEach (get_config, list_devices, etc.) just resolves
      default:
        return undefined;
    }
  }) as any); // eslint-disable-line @typescript-eslint/no-explicit-any
}

describe("Fix wizard — happy path (device already in ratbagd)", () => {
  it("goes straight to reading (never shows Preparing) when device is already in ratbagd", async () => {
    // Use a deferred ratbag_status to freeze the wizard BEFORE the device-id
    // check resolves. This lets us assert that the preparing phase is NOT set
    // while we wait — if the old unconditional setFixPhase({ kind: "preparing" })
    // were present, the "Preparing the fix" text would appear here.
    let resolveStatus!: (v: unknown) => void;
    const statusDeferred = new Promise((res) => { resolveStatus = res; });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      if (cmd === "ratbag_status") return statusDeferred;
      if (cmd === "ratbag_read_buttons") {
        return [
          { index: 0, action: "button 1", human: "Left click" },
          { index: 3, action: "button 1", human: "Left click" },
        ];
      }
      if (cmd === "ratbag_suggest_rewrites") return [[3, "macro +KEY_F13 -KEY_F13"]] as [number, string][];
      return undefined;
    }) as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    const { getEventCb } = setupListenMock();
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={() => {}} />);

    const cb = getEventCb()!;
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    // Click the fix button — wizard starts, calls ratbag_status which hangs.
    // Use synchronous fireEvent so the click is dispatched before we flush.
    fireEvent.click(screen.getByRole("button", { name: "Fix this mouse's memory" }));

    // Flush the initial microtask round that runs up to the first await
    // (ratbag_status). At this point the status promise is still pending.
    await act(async () => {
      await Promise.resolve();
    });

    // While ratbag_status is pending, "Preparing the fix" must NOT appear.
    // (With the old broken code, setFixPhase({ kind: "preparing" }) fired
    //  unconditionally BEFORE the await, so this assertion would FAIL with:
    //  expected <p>Preparing the fix — you'll be asked for your password once.</p> to be null)
    expect(screen.queryByText(/Preparing the fix/i)).toBeNull();

    // Now resolve status with device already present — no preparing phase needed.
    await act(async () => {
      resolveStatus({ daemon_running: true, device_id: "usb_046d_c099_if01", device_name: "Logitech G502 X PLUS" });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Wizard proceeds to confirm sheet — check it arrived without preparing
    await waitFor(() => {
      expect(screen.getByText(/will send its own signal/i)).toBeInTheDocument();
    });
    expect(screen.queryByText(/Preparing the fix/i)).toBeNull();
  });

  it("'Preparing the fix' is NEVER visible when device is already in ratbagd — full wizard flow", async () => {
    setupRatbagHappyPath();
    const { getEventCb } = setupListenMock();
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={() => {}} />);

    const cb = getEventCb()!;
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    // Start wizard
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix this mouse's memory" }));
    });

    // Wait until we reach the confirm sheet
    await waitFor(() => {
      expect(screen.getByText(/will send its own signal/i)).toBeInTheDocument();
    });

    // "Preparing the fix" must not appear at confirm time either
    expect(screen.queryByText("Preparing the fix — you'll be asked for your password once.")).toBeNull();
  });

  it("renders the confirm sheet with a button row and the exact footer", async () => {
    setupRatbagHappyPath();
    const { getEventCb } = setupListenMock();
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={() => {}} />);

    const cb = getEventCb()!;
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix this mouse's memory" }));
    });

    // Wait for the confirm sheet to appear
    await waitFor(() => {
      expect(screen.getByText(/will send its own signal/i)).toBeInTheDocument();
    });

    // Confirm sheet must show the verbatim footer
    expect(screen.getByText(
      "This changes the mouse's own memory — other computers (and G HUB) will see these assignments too."
    )).toBeInTheDocument();

    // Confirm sheet must show a "Left click → will send its own signal" row
    // (the "Left click" comes from the human label in ratbag_read_buttons mock)
    expect(screen.getByText(/Left click/i)).toBeInTheDocument();

    // Cancel button must be present
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();

    // "Rewrite N buttons" button must be present (N=1 from our mock)
    expect(screen.getByRole("button", { name: /Rewrite 1 button/i })).toBeInTheDocument();
  });

  it("does NOT call ratbag_rewrite before the user clicks confirm", async () => {
    setupRatbagHappyPath();
    const { getEventCb } = setupListenMock();
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={() => {}} />);

    const cb = getEventCb()!;
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix this mouse's memory" }));
    });

    // Wait for confirm sheet to appear
    await waitFor(() => {
      expect(screen.getByText(/will send its own signal/i)).toBeInTheDocument();
    });

    // ratbag_rewrite must NOT have been called yet
    const rewriteCalls = mockInvoke.mock.calls.filter((c) => c[0] === "ratbag_rewrite");
    expect(rewriteCalls).toHaveLength(0);
  });

  it("calls ratbag_rewrite with the correct targets after confirm and enters re-check phase", async () => {
    setupRatbagHappyPath();
    const { getEventCb } = setupListenMock();
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={() => {}} />);

    const cb = getEventCb()!;
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix this mouse's memory" }));
    });

    // Wait for confirm sheet
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Rewrite 1 button/i })).toBeInTheDocument();
    });

    // Click confirm / rewrite button
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Rewrite 1 button/i }));
    });

    // Wait for re-check phase — should show exact copy "Press the fixed buttons to confirm"
    await waitFor(() => {
      expect(screen.getByText("Press the fixed buttons to confirm")).toBeInTheDocument();
    });

    // ratbag_rewrite must have been called with the targets from ratbag_suggest_rewrites
    const rewriteCall = mockInvoke.mock.calls.find((c) => c[0] === "ratbag_rewrite");
    expect(rewriteCall).toBeDefined();
    // targets should be [[3, "macro +KEY_F13 -KEY_F13"]]
    expect(rewriteCall![1]).toMatchObject({
      targets: [[3, "macro +KEY_F13 -KEY_F13"]],
    });
  });

  it("after re-check press-then-done shows 'All N buttons are now distinct'", async () => {
    setupRatbagHappyPath();
    const { getEventCb: getEventCb1 } = setupListenMock();
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={() => {}} />);

    // First: trigger the collision
    const cb1 = getEventCb1()!;
    await fireKeyEvent(cb1, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb1, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb1, "key:272", 0x110, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    // Fix flow
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix this mouse's memory" }));
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Rewrite 1 button/i })).toBeInTheDocument();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Rewrite 1 button/i }));
    });

    // Now in re-check phase
    await waitFor(() => {
      expect(screen.getByText(/Press the fixed buttons to confirm/i)).toBeInTheDocument();
    });

    // Fire distinct presses and click Done
    const cb2 = getEventCb1()!;
    await fireKeyEvent(cb2, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb2, "key:273", 0x111, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    await waitFor(() => {
      expect(screen.getByText(/All \d+ buttons are now distinct/i)).toBeInTheDocument();
    });
  });

  it("Cancel on confirm sheet returns to the collision verdict without calling rewrite", async () => {
    setupRatbagHappyPath();
    const { getEventCb } = setupListenMock();
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={() => {}} />);

    const cb = getEventCb()!;
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix this mouse's memory" }));
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    });

    // Should be back to collision verdict
    expect(
      screen.getByText(
        "1 of this mouse's buttons share signals, so Conduit can't tell them apart. This is stored in the mouse itself."
      )
    ).toBeInTheDocument();

    // rewrite was NOT called
    expect(mockInvoke.mock.calls.filter((c) => c[0] === "ratbag_rewrite")).toHaveLength(0);
  });
});

describe("Fix wizard — device needs staging (not yet in ratbagd)", () => {
  // Use fake timers in this describe block so the 500 ms poll loop inside the
  // component does not run past the end of the test and cause dangling state
  // updates / act() warnings. The global afterEach(vi.useRealTimers) hook
  // restores timers even if the test throws.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("shows 'Preparing the fix' text when ratbagd does not know the device, then reaches confirm sheet", async () => {
    let statusCallCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      switch (cmd) {
        case "ratbag_status":
          statusCallCount++;
          if (statusCallCount <= 1) {
            // First call: device not found
            return { daemon_running: true, device_id: null, device_name: null };
          }
          // Poll calls: device now available
          return {
            daemon_running: true,
            device_id: "usb_046d_c099_if01",
            device_name: "Logitech G502 X PLUS",
          };
        case "ratbag_stage_device_file":
          return "/tmp/ratbag-patch/logitech-g502-x-wireless.device";
        case "ratbag_fix_setup":
          return undefined;
        case "ratbag_read_buttons":
          return [
            { index: 0, action: "button 1", human: "Left click" },
            { index: 3, action: "button 1", human: "Left click" },
          ] satisfies { index: number; action: string; human: string }[];
        case "ratbag_suggest_rewrites":
          return [[3, "macro +KEY_F13 -KEY_F13"]] as [number, string][];
        case "ratbag_rewrite":
          return undefined;
        default:
          return undefined;
      }
    }) as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    const { getEventCb } = setupListenMock();
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={() => {}} />);

    const cb = getEventCb()!;
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    // Start the fix wizard — status check + stage + fix_setup are all Promise-based;
    // flush several microtask rounds inside act() so they resolve before we assert.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix this mouse's memory" }));
      // Multiple flushes to let the async chain (status → stage → fix_setup) complete.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Device was missing → component must show "Preparing the fix" now.
    expect(screen.getByText(/Preparing the fix/i)).toBeInTheDocument();

    // Advance the fake clock past one poll tick (500 ms) so the while-loop wakes
    // and calls ratbag_status a second time. Use synchronous advanceTimersByTime
    // inside act() — the same pattern as Setup.test.tsx and Toast.test.tsx in
    // this project.
    await act(async () => {
      vi.advanceTimersByTime(600);
      // Flush microtasks for the poll's ratbag_status call + subsequent
      // read_buttons + suggest_rewrites calls.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The poll found the device; wizard should now be on the confirm sheet.
    // Use direct expect (not waitFor) to avoid relying on setTimeout-based polling
    // while fake timers are active.
    expect(screen.getByText(/will send its own signal/i)).toBeInTheDocument();
  });
});

describe("Fix wizard — pkexec dismissed (permission-denied)", () => {
  it("shows 'You closed the password prompt' inline when ratbag_fix_setup returns permission-denied", async () => {
    let statusCallCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      switch (cmd) {
        case "ratbag_status":
          statusCallCount++;
          if (statusCallCount <= 1) {
            return { daemon_running: true, device_id: null, device_name: null };
          }
          return { daemon_running: true, device_id: null, device_name: null };
        case "ratbag_stage_device_file":
          return "/tmp/ratbag-patch/logitech-g502-x-wireless.device";
        case "ratbag_fix_setup": {
          const err = { code: "permission-denied", message: "pkexec dismissed", detail: "exit code 126" };
          return Promise.reject(err);
        }
        default:
          return undefined;
      }
    }) as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    const { getEventCb } = setupListenMock();
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={() => {}} />);

    const cb = getEventCb()!;
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix this mouse's memory" }));
    });

    // Should show "You closed the password prompt" error inline
    await waitFor(() => {
      expect(screen.getByText(/You closed the password prompt/i)).toBeInTheDocument();
    });

    // Jargon ban: "permission-denied" code must not appear as user-facing text
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toMatch(/\bpolkit\b/i);
    expect(bodyText).not.toMatch(/\bpkexec\b/i);
    expect(bodyText).not.toMatch(/ratbagd/);
  });

  it("shows technical details pane with raw stderr after pkexec dismissal", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      switch (cmd) {
        case "ratbag_status":
          return { daemon_running: true, device_id: null, device_name: null };
        case "ratbag_stage_device_file":
          return "/tmp/ratbag-patch/logitech-g502-x-wireless.device";
        case "ratbag_fix_setup": {
          const err = { code: "permission-denied", message: "pkexec dismissed", detail: "exit code 126" };
          return Promise.reject(err);
        }
        default:
          return undefined;
      }
    }) as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    const { getEventCb } = setupListenMock();
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={() => {}} />);

    const cb = getEventCb()!;
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix this mouse's memory" }));
    });

    await waitFor(() => {
      expect(screen.getByText(/You closed the password prompt/i)).toBeInTheDocument();
    });

    // Raw stderr is inside the "Show technical details" pane — not visible by default
    expect(screen.queryByText(/exit code 126/)).toBeNull();

    // Click show technical details
    await act(async () => {
      fireEvent.click(screen.getByText("Show technical details"));
    });

    // Now the raw detail should appear
    expect(screen.getByText(/exit code 126/)).toBeInTheDocument();
  });
});

describe("Fix wizard — rewrite failure", () => {
  it("shows error and detail quarantine when ratbag_rewrite fails", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      switch (cmd) {
        case "ratbag_status":
          return {
            daemon_running: true,
            device_id: "usb_046d_c099_if01",
            device_name: "Logitech G502 X PLUS",
          };
        case "ratbag_read_buttons":
          return [
            { index: 0, action: "button 1", human: "Left click" },
            { index: 3, action: "button 1", human: "Left click" },
          ] satisfies { index: number; action: string; human: string }[];
        case "ratbag_suggest_rewrites":
          return [[3, "macro +KEY_F13 -KEY_F13"]] as [number, string][];
        case "ratbag_rewrite": {
          const err = { code: "internal", message: "ratbagctl failed", detail: "stderr: command failed on button 3" };
          return Promise.reject(err);
        }
        default:
          return undefined;
      }
    }) as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    const { getEventCb } = setupListenMock();
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={() => {}} />);

    const cb = getEventCb()!;
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix this mouse's memory" }));
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Rewrite 1 button/i })).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Rewrite 1 button/i }));
    });

    // Error title should appear inline (presentError maps "internal" → "Something went wrong")
    await waitFor(() => {
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    });

    // Raw stderr is hidden by default (quarantine)
    expect(screen.queryByText(/stderr: command failed on button 3/)).toBeNull();

    // Click show technical details to reveal it
    await act(async () => {
      fireEvent.click(screen.getByText("Show technical details"));
    });

    expect(screen.getByText(/stderr: command failed on button 3/)).toBeInTheDocument();

    // Jargon bans
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toMatch(/ratbagd/);
    expect(bodyText).not.toMatch(/KEY_/);
  });
});

describe("Fix wizard — jargon ban", () => {
  it("does not show banned jargon in wizard UI (preparing stage)", async () => {
    let statusCallCount = 0;
    // Make it hang at staging so we can inspect the preparing text
    let stageResolve: (() => void) | null = null;
    const stagePending = new Promise<string>((resolve) => {
      stageResolve = () => resolve("/tmp/patch/device");
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockInvoke.mockImplementation((async (cmd: string) => {
      switch (cmd) {
        case "ratbag_status":
          statusCallCount++;
          return statusCallCount <= 1
            ? { daemon_running: true, device_id: null, device_name: null }
            : { daemon_running: true, device_id: "usb_046d_c099_if01", device_name: "Logitech G502 X PLUS" };
        case "ratbag_stage_device_file":
          return stagePending;
        default:
          return undefined;
      }
    }) as any); // eslint-disable-line @typescript-eslint/no-explicit-any

    const { getEventCb } = setupListenMock();
    render(<ButtonCheck device={G502X} onClose={() => {}} onFix={() => {}} />);

    const cb = getEventCb()!;
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:273", 0x111, "Logitech G502 X PLUS");
    await fireKeyEvent(cb, "key:272", 0x110, "Logitech G502 X PLUS");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Done" })); });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fix this mouse's memory" }));
    });

    await waitFor(() => {
      expect(screen.getByText(/Preparing the fix/i)).toBeInTheDocument();
    });

    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toMatch(/\bdaemon\b/i);
    expect(bodyText).not.toMatch(/\bsocket\b/i);
    expect(bodyText).not.toMatch(/\buinput\b/i);
    expect(bodyText).not.toMatch(/\budev\b/i);
    expect(bodyText).not.toMatch(/\bsystemd\b/i);
    expect(bodyText).not.toMatch(/\bpolkit\b/i);
    expect(bodyText).not.toMatch(/ratbagd/);
    expect(bodyText).not.toMatch(/HID\+\+/);
    expect(bodyText).not.toMatch(/KEY_/);

    // Resolve the pending promise to avoid dangling async
    await act(async () => {
      stageResolve!();
      await new Promise((r) => setTimeout(r, 50));
    });
  });
});
