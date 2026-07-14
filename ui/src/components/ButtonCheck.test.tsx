/**
 * ButtonCheck component tests — Task 4.
 *
 * Tests are written first (failing); implementation follows.
 *
 * Mocking convention: vi.mock("../lib/client") before importing the component.
 * The onKeyEvent function returns a Promise<() => void> (unlisten handle).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// ── Mock Tauri APIs before importing anything that uses them ──────────────────

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { listen } from "@tauri-apps/api/event";

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

    await act(async () => { fireEvent.click(fixBtn); });
    expect(onFix).toHaveBeenCalledTimes(1);
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
