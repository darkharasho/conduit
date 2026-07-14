import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { StatusScreen } from "./Status";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const mockGetStatus = vi.fn();

vi.mock("../lib/client", () => ({
  getStatus: () => mockGetStatus(),
  onStatus: () => Promise.resolve(() => {}),
  onConnection: () => Promise.resolve([() => {}, () => {}]),
  ConduitError: class ConduitError extends Error {
    code: string; detail: string;
    constructor(code: string, message: string, detail = "") {
      super(message); this.name = "ConduitError"; this.code = code; this.detail = detail;
    }
  },
}));

vi.mock("./Setup", () => ({
  SetupScreen: () => <div data-testid="setup-screen" />,
}));

beforeEach(() => {
  mockGetStatus.mockReset();
});

describe("phase 6 nits", () => {
  it("item 7: daemon unreachable shows presentError title, no raw error string", async () => {
    // engine-not-running is the most common error code for StatusScreen
    const { ConduitError } = await import("../lib/client");
    mockGetStatus.mockRejectedValue(
      new ConduitError("engine-not-running", "connect refused", "ECONNREFUSED /var/run/conduit.sock")
    );
    render(<StatusScreen />);
    await act(async () => { await Promise.resolve(); });
    // Must show presentError title ("Conduit's engine isn't running")
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toContain("ECONNREFUSED");
    expect(alert.textContent).not.toContain("conduit.sock");
    expect(alert.textContent).not.toContain("connect refused");
  });
});
