import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import App from "./App";

const sampleStatus = {
  active_profile: "default",
  active_layers: ["base"],
  suspended: false,
  focus: { process: "sai", class: "sai", title: "SAI" },
  grabbed_devices: ["/dev/input/event2"],
  version: "0.1.0",
  config_version: 0,
};

// Tests rewritten for home-first navigation (Phase 2 shell rework).
// Deleted tests:
//   - "seeds grabbed count and daemon-ok from getStatus on mount"
//     (asserted .status-bar__val and .status-bar__dot--ok — status bar removed)
//   - "profiles rail is visible outside the Mappings screen"
//     (asserted nav button "Devices" and the old 4-screen nav rail — both removed)

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
  listDevices: vi.fn(async () => [
    {
      path: "/dev/input/event0",
      name: "Logitech G502 X",
      vendor: 0x046d,
      product: 0x4099,
      is_keyboard: false,
      is_mouse: true,
      grabbed: true,
      id: "046d:4099/x",
      class: "mouse",
      phys: "",
      keys: [],
      wheel: true,
      hwheel: false,
    },
  ]),
  suspend: vi.fn(async () => {}),
  resume: vi.fn(async () => {}),
  onStatus: vi.fn(() => Promise.resolve(() => {})),
  onConnection: vi.fn(() => Promise.resolve([() => {}, () => {}])),
  onKeyEvent: vi.fn(() => Promise.resolve(() => {})),
}));

describe("App shell — home-first navigation", () => {
  it("opens on the home screen with no status bar daemon dot", async () => {
    render(<App />);
    expect(await screen.findByText("Your devices")).toBeInTheDocument();
    // Status bar (with daemon dot) is removed entirely
    expect(document.querySelector(".status-bar")).toBeNull();
    expect(document.querySelector(".status-bar__dot--ok")).toBeNull();
    expect(document.querySelector(".status-bar__dot--err")).toBeNull();
  });

  it("opens on the home screen with no daemon jargon", async () => {
    render(<App />);
    await screen.findByText("Your devices");
    expect(screen.queryByText(/daemon/i)).toBeNull();
  });

  it("shows the pause control and no connection dot in the titlebar", async () => {
    render(<App />);
    expect(await screen.findByRole("button", { name: /Pause Conduit/ })).toBeInTheDocument();
    expect(document.querySelector(".titlebar__daemon")).toBeNull();
  });

  it("shows an unmissable banner when paused", async () => {
    const { getStatus } = await import("./lib/client");
    const mockGetStatus = vi.mocked(getStatus);
    // Scope the suspended mock to this test only — restore the default after.
    mockGetStatus.mockResolvedValue({ ...sampleStatus, suspended: true });
    try {
      render(<App />);
      expect(await screen.findByRole("status")).toHaveTextContent(
        "Conduit is paused — your buttons have their normal behavior.",
      );
    } finally {
      mockGetStatus.mockResolvedValue({ ...sampleStatus, suspended: false });
    }
  });

  it("navigates home → device editor → back", async () => {
    render(<App />);
    const card = await screen.findByRole("button", { name: /Logitech G502 X/ });
    fireEvent.click(card);
    expect(await screen.findByText(/‹ Your devices/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/‹ Your devices/));
    expect(await screen.findByText("Your devices")).toBeInTheDocument();
  });
});

describe("Plain-language profile rail and app picker", () => {
  it("shows the default profile as Everywhere and app profiles with an auto badge", async () => {
    const { getConfig } = await import("./lib/client");
    vi.mocked(getConfig).mockResolvedValue(
      '[profile.default.keys]\na = "b"\n[profile.firefox]\nmatch = { class = "firefox" }\n[profile.firefox.keys]\nmouse4 = "back"'
    );
    render(<App />);
    // Navigate into device view to see profiles rail
    const card = await screen.findByRole("button", { name: /Logitech G502 X/ });
    fireEvent.click(card);
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
    // Navigate into device view to see profiles rail with the add button
    const card = await screen.findByRole("button", { name: /Logitech G502 X/ });
    fireEvent.click(card);
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
