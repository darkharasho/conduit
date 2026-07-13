import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AssignPanel } from "./AssignPanel";
import { parseConfigToml } from "../lib/config-model";

vi.mock("../lib/client", () => ({
  captureNextKey: vi.fn(async () => ({ name: "volumeup", code: 115 })),
}));

import { captureNextKey } from "../lib/client";

const MODEL = parseConfigToml('[profile.default.keys]\nmouse4 = "back"');

function renderPanel(overrides: Partial<Parameters<typeof AssignPanel>[0]> = {}) {
  const props = {
    keyName: "mouse4",
    model: MODEL,
    activeProfile: "default",
    activeLayer: "base",
    currentAction: { kind: "key", key: "back" } as const,
    tomlEcho: null,
    onSave: vi.fn(async () => {}),
    onUseDefault: vi.fn(async () => {}),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<AssignPanel {...props} />);
  return props;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AssignPanel", () => {
  it("shows the button and its current job in plain language", () => {
    renderPanel();
    expect(screen.getByRole("heading", { name: "Back button" })).toBeInTheDocument();
    expect(screen.getByText(/Now:/)).toHaveTextContent("Now: Back");
  });

  it("says 'Normal job' when the key is unmapped", () => {
    renderPanel({ currentAction: null });
    expect(screen.getByText(/Now:/)).toHaveTextContent("Now: Normal job");
  });

  it("press-to-set captures a key and saves it in one step", async () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /press to set/i }));
    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith({ kind: "key", key: "volumeup" })
    );
    expect(captureNextKey).toHaveBeenCalledOnce();
  });

  it("quick picks save immediately", async () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /play \/ pause/i }));
    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith({ kind: "key", key: "playpause" })
    );
  });

  it("'Use default' reverts and 'Disable button' saves disabled", async () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Use default" }));
    await waitFor(() => expect(props.onUseDefault).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Disable button" }));
    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith({ kind: "disabled" })
    );
  });

  it("hides advanced options until asked", () => {
    renderPanel();
    // The advanced editor's kind selector is not in the document by default
    expect(screen.queryByText("tap-hold")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /advanced/i }));
    expect(screen.getByText("tap-hold")).toBeInTheDocument();
  });
});
