import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfigToml } from "../lib/config-model";
import { AppPicker } from "./AppPicker";

const mockListWindows = vi.fn();
const mockListInstalledApps = vi.fn();
vi.mock("../lib/client", () => ({
  listWindows: (...a: unknown[]) => mockListWindows(...a),
  listInstalledApps: (...a: unknown[]) => mockListInstalledApps(...a),
}));

const MODEL = parseConfigToml('[profile.default.keys]\n\n[profile.firefox]\nmatch = { class = "firefox" }\n[profile.firefox.keys]\nf1 = "back"\n');

beforeEach(() => {
  mockListWindows.mockResolvedValue([
    { process: "firefox", class: "firefox", title: "Mozilla Firefox" },
    { process: "steam", class: "steam", title: "Steam" },
  ]);
  mockListInstalledApps.mockResolvedValue([
    { app_id: "steam", name: "Steam", wm_class: null, categories: ["Game"], icon: null },
    { app_id: "org.kde.dolphin", name: "Dolphin", wm_class: "dolphin", categories: [], icon: null },
  ]);
});

describe("AppPicker", () => {
  it("lists open windows minus already-added apps, plus installed apps", async () => {
    render(<AppPicker model={MODEL} onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Steam")).toBeInTheDocument());
    expect(screen.queryByText(/firefox/i)).toBeNull();     // already has a pill
    expect(screen.getByText("Dolphin")).toBeInTheDocument();
  });

  it("picks an installed app", async () => {
    const onPick = vi.fn();
    render(<AppPicker model={MODEL} onPick={onPick} onClose={() => {}} />);
    fireEvent.click(await screen.findByText("Dolphin"));
    expect(onPick).toHaveBeenCalledWith("Dolphin", "dolphin");
  });

  it("does not render the advanced link", async () => {
    render(<AppPicker model={MODEL} onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Steam")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Advanced/i })).toBeNull();
  });

  it("installed app whose wm_class matches an existing pill is excluded while non-matching apps remain", async () => {
    // Firefox already has a pill (class = "firefox"). The installed-apps list
    // includes Firefox (wm_class "firefox") and Dolphin (wm_class "dolphin").
    // Firefox must be absent; Dolphin must still appear.
    mockListInstalledApps.mockResolvedValue([
      { app_id: "org.mozilla.firefox", name: "Firefox", wm_class: "firefox", categories: ["WebBrowser"], icon: null },
      { app_id: "org.kde.dolphin", name: "Dolphin", wm_class: "dolphin", categories: [], icon: null },
    ]);
    render(<AppPicker model={MODEL} onPick={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Dolphin")).toBeInTheDocument());
    // Firefox installed row must not render — it already has a pill
    expect(screen.queryByText("Firefox")).toBeNull();
    expect(screen.getByText("Dolphin")).toBeInTheDocument();
  });
});
