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
    expect(screen.getByText(/Right now it does:/)).toBeInTheDocument();
  });

  it("says 'Normal job' when the key is unmapped", () => {
    renderPanel({ currentAction: null });
    expect(screen.getByText(/Right now it does:/)).toHaveTextContent("Normal job");
  });

  it("shows Popular by default and saves a catalog entry on click", async () => {
    const { onSave } = renderPanel();
    expect(screen.getByPlaceholderText(/Search anything/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ kind: "chord", keys: ["leftctrl", "c"] }),
    );
  });

  it("search finds actions and typed combos become a custom row", async () => {
    const { onSave } = renderPanel();
    fireEvent.change(screen.getByPlaceholderText(/Search anything/), {
      target: { value: "ctrl+z" },
    });
    expect(screen.getByText("Undo")).toBeInTheDocument(); // catalog hit (subtitle Ctrl + Z)
    fireEvent.click(screen.getByRole("button", { name: /Press Ctrl \+ Z/ }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ kind: "chord", keys: ["leftctrl", "z"] }),
    );
  });

  it("renders the plain-language escape hatches", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Use the button's normal behavior" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Do nothing when pressed" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Advanced: tap & hold, layers/ })).toBeInTheDocument();
  });

  it("Keys category exposes press-to-set", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    expect(screen.getByRole("button", { name: /Press a key to type it/ })).toBeInTheDocument();
  });

  it("press-to-set in Keys category captures a key and saves it", async () => {
    const { onSave } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Keys" }));
    fireEvent.click(screen.getByRole("button", { name: /Press a key to type it/ }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ kind: "key", key: "volumeup" })
    );
    expect(captureNextKey).toHaveBeenCalledOnce();
  });

  it("'Use the button's normal behavior' calls onUseDefault", async () => {
    const { onUseDefault } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Use the button's normal behavior" }));
    await waitFor(() => expect(onUseDefault).toHaveBeenCalledOnce());
  });

  it("'Do nothing when pressed' saves disabled", async () => {
    const { onSave } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Do nothing when pressed" }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ kind: "disabled" })
    );
  });

  it("hides InspectorPanel until Advanced link is clicked", () => {
    renderPanel();
    // The advanced editor's kind selector is not in the document by default
    expect(screen.queryByText("tap-hold")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Advanced: tap & hold, layers/ }));
    expect(screen.getByText("tap-hold")).toBeInTheDocument();
  });
});
