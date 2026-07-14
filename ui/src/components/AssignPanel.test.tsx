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

  it("hides the TOML echo behind Show configuration", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Advanced: tap & hold, layers/ }));
    expect(screen.queryByText(/conduit\.toml/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show configuration" }));
    expect(screen.getByText(/conduit\.toml/)).toBeInTheDocument();
  });

  it("shows the app eyebrow and Everywhere hatch in app context", () => {
    renderPanel({ appContext: { label: "Firefox", everywhereLabel: "Copy" } });
    expect(screen.getByText("In Firefox")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use the Everywhere setting (Copy)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use the button's normal behavior" })).toBeNull();
  });

  it("browser context: Back and Forward appear before Copy in Popular", () => {
    renderPanel({ appContext: { label: "Firefox", everywhereLabel: null, isBrowser: true } });
    const rows = screen.getAllByRole("button", { name: /^(Back|Forward|Copy|Paste|Undo|Mute|Play|Take a screenshot)/ });
    const labels = rows.map((b) => b.querySelector(".cat-row__label")?.textContent ?? b.textContent ?? "");
    const backIdx = labels.findIndex((l) => l === "Back");
    const forwardIdx = labels.findIndex((l) => l === "Forward");
    const copyIdx = labels.findIndex((l) => l === "Copy");
    expect(backIdx).toBeGreaterThanOrEqual(0);
    expect(forwardIdx).toBeGreaterThanOrEqual(0);
    expect(copyIdx).toBeGreaterThanOrEqual(0);
    expect(backIdx).toBeLessThan(copyIdx);
    expect(forwardIdx).toBeLessThan(copyIdx);
  });

  it("non-browser context: Popular order is unchanged (Copy before Back)", () => {
    renderPanel({ appContext: { label: "Code", everywhereLabel: null, isBrowser: false } });
    const rows = screen.getAllByRole("button", { name: /^(Back|Copy)/ });
    const labels = rows.map((b) => b.querySelector(".cat-row__label")?.textContent ?? b.textContent ?? "");
    const backIdx = labels.findIndex((l) => l === "Back");
    const copyIdx = labels.findIndex((l) => l === "Copy");
    // In default order, Copy (popular shortcuts) comes before Back (popular keys)
    expect(copyIdx).toBeLessThan(backIdx);
  });
});
