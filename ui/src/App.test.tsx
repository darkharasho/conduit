import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import App from "./App";

// Regression: the Tauri process emits conduit://connected before the webview
// registers listeners, so the shell must seed connection + status from a
// one-shot getStatus() on mount. Without the seed the daemon dot stayed red
// and the bottom bar showed "grabbed: 0" while the Status screen showed 1.

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock("./lib/client", () => ({
  getStatus: vi.fn(async () => ({
    active_profile: "default",
    active_layers: ["base"],
    suspended: false,
    focus: { process: "sai", class: "sai", title: "SAI" },
    grabbed_devices: ["/dev/input/event2"],
    version: "0.1.0",
  })),
  getConfig: vi.fn(async () => '[profile.default.keys]\na = "b"'),
  setConfig: vi.fn(async () => {}),
  listWindows: vi.fn(async () => []),
  listDevices: vi.fn(async () => []),
  suspend: vi.fn(async () => {}),
  resume: vi.fn(async () => {}),
  onStatus: vi.fn(() => Promise.resolve(() => {})),
  onConnection: vi.fn(() => Promise.resolve([() => {}, () => {}])),
  onKeyEvent: vi.fn(() => Promise.resolve(() => {})),
}));

describe("App shell status seeding", () => {
  it("seeds grabbed count and daemon-ok from getStatus on mount", async () => {
    render(<App />);
    // Bottom bar reflects the seeded status, not 0/red.
    const grabbed = await screen.findByText("1", { selector: ".status-bar__val" });
    expect(grabbed).toBeInTheDocument();
    expect(document.querySelector(".status-bar__dot--ok")).not.toBeNull();
    expect(document.querySelector(".status-bar__dot--err")).toBeNull();
    // Titlebar daemon indicator turns ok too.
    expect(document.querySelector(".titlebar__daemon--ok")).not.toBeNull();
  });

  it("profiles rail is visible outside the Mappings screen", async () => {
    render(<App />);
    await screen.findAllByText("Everywhere");
    // Switch to the Devices screen via its nav button…
    const devicesNav = screen.getAllByRole("button", { name: /Devices/ })[0];
    devicesNav.click();
    // …profiles section is still there.
    expect(screen.getByText("Profiles")).toBeInTheDocument();
    expect(screen.getByText("+ Profile for an app…")).toBeInTheDocument();
  });
});

describe("Plain-language profile rail and app picker", () => {
  it("shows the default profile as Everywhere and app profiles with an auto badge", async () => {
    const { getConfig } = await import("./lib/client");
    vi.mocked(getConfig).mockResolvedValue(
      '[profile.default.keys]\na = "b"\n[profile.firefox]\nmatch = { class = "firefox" }\n[profile.firefox.keys]\nmouse4 = "back"'
    );
    render(<App />);
    await screen.findByText("firefox");
    expect(screen.getByText("Everywhere")).toBeInTheDocument();
    expect(screen.getByText("AUTO")).toBeInTheDocument();
    // The technical match label is gone from the rail
    expect(screen.queryByText("class:firefox")).not.toBeInTheDocument();
  });

  it("app picker lists open apps and disables ones that already have a profile", async () => {
    const { getConfig, listWindows } = await import("./lib/client");
    vi.mocked(getConfig).mockResolvedValue(
      '[profile.default.keys]\na = "b"\n[profile.firefox]\nmatch = { class = "firefox" }\n[profile.firefox.keys]\nmouse4 = "back"'
    );
    vi.mocked(listWindows).mockResolvedValue([
      { process: "firefox", class: "firefox", title: "Home" },
      { process: "steam", class: "steam", title: "Steam" },
    ]);
    render(<App />);
    await screen.findByText("firefox");
    screen.getByText("+ Profile for an app…").click();
    await screen.findByText("Profile for an app");
    // Steam is pickable; Firefox already has a profile and is disabled.
    const steamRow = (await screen.findByText("steam")).closest("button")!;
    expect(steamRow).toBeEnabled();
    const firefoxRow = screen.getByText(/already has a profile/).closest("button")!;
    expect(firefoxRow).toBeDisabled();
  });
});
