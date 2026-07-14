import { render, screen, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InspectorPanel } from "./InspectorPanel";
import { parseConfigToml } from "../lib/config-model";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("../lib/client", () => ({
  captureNextKey: vi.fn(() => new Promise(() => {})),
}));

const MODEL_WITH_CHORD = parseConfigToml('[profile.default.keys]\na = "leftctrl+c"');
const MODEL_EMPTY = parseConfigToml('[profile.default.keys]\n');

describe("phase 6 nits", () => {
  it("item 12: Apply button is disabled when kind === 'chord'", async () => {
    const onSave = vi.fn();
    render(
      <InspectorPanel
        keyName="a"
        model={MODEL_WITH_CHORD}
        activeProfile="default"
        activeLayer="base"
        tomlEcho={null}
        onSave={onSave}
        onClose={() => {}}
      />
    );
    // The existing action is a chord, so the kind selector starts on "chord"
    // Wait for render to settle
    await act(async () => { await Promise.resolve(); });
    const applyBtn = screen.getByRole("button", { name: "Apply" });
    expect(applyBtn).toBeDisabled();
  });

  it("item 12: Apply button is enabled for non-chord kinds", async () => {
    const onSave = vi.fn();
    render(
      <InspectorPanel
        keyName="a"
        model={MODEL_EMPTY}
        activeProfile="default"
        activeLayer="base"
        tomlEcho={null}
        onSave={onSave}
        onClose={() => {}}
      />
    );
    await act(async () => { await Promise.resolve(); });
    // Default kind is "key", which is not chord → Apply should be enabled
    const applyBtn = screen.getByRole("button", { name: "Apply" });
    expect(applyBtn).not.toBeDisabled();
  });
});
