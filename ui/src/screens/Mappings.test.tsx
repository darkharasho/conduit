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
