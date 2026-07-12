import { useCallback, useEffect, useState } from "react";
import {
  onConnection,
  onStatus,
  getConfig,
  setConfig,
  getStatus,
  listWindows,
} from "./lib/client";
import type { Status, FocusInfo } from "./lib/client";
import { Titlebar } from "./components/Titlebar";
import {
  parseConfigToml,
  serializeConfigToml,
  listProfiles,
  getProfileMatchLabel,
  addProfile,
} from "./lib/config-model";
import type { ConfigModel } from "./lib/config-model";
import { StatusScreen } from "./screens/Status";
import { MappingsScreen } from "./screens/Mappings";
import { KeyTesterScreen } from "./screens/KeyTester";
import { DevicesScreen } from "./screens/Devices";

type Screen = "mappings" | "key-tester" | "devices" | "status";

const NAV_ITEMS: { id: Screen; label: string; key: string }[] = [
  { id: "mappings",    label: "Mappings",   key: "1" },
  { id: "key-tester", label: "Key Tester", key: "2" },
  { id: "devices",    label: "Devices",    key: "3" },
  { id: "status",     label: "Status",     key: "4" },
];

function App() {
  const [activeScreen, setActiveScreen] = useState<Screen>("mappings");
  const [connected, setConnected] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  // Config model for profile rail
  const [configModel, setConfigModel] = useState<ConfigModel | null>(null);
  const [activeProfile, setActiveProfile] = useState("default");

  // Profile add modal state (lifted from MappingsScreen to break CustomEvent bus)
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [modalWindows, setModalWindows] = useState<FocusInfo[]>([]);
  const [loadingWindows, setLoadingWindows] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const toml = await getConfig();
      const m = parseConfigToml(toml);
      setConfigModel(m);
    } catch {
      // Non-fatal
    }
  }, []);

  // Seed status with a one-shot query. The Tauri process emits
  // conduit://connected when ITS subscription connects — often before this
  // webview has registered listeners — so without this seed the shell shows
  // a red daemon dot and 0 grabbed devices until the next status push.
  const refreshStatus = useCallback(async () => {
    try {
      const s = await getStatus();
      setStatus(s);
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }, []);

  // Stable callback: re-fetch model when profiles change, keep activeProfile valid
  const handleProfilesChange = useCallback((names: string[]) => {
    loadConfig();
    setActiveProfile((prev) => {
      if (!names.includes(prev) && names.length > 0) return names[0];
      return prev;
    });
  }, [loadConfig]);

  // Stable callback: open the "new profile" window picker modal
  const handleOpenAddProfile = useCallback(async () => {
    setShowProfileModal(true);
    setLoadingWindows(true);
    setWindowError(null);
    try {
      const wins = await listWindows();
      setModalWindows(wins);
    } catch (err) {
      setWindowError(String(err));
    } finally {
      setLoadingWindows(false);
    }
  }, []);

  const handleSelectWindow = useCallback((win: FocusInfo) => {
    const name = win.class.toLowerCase().replace(/\s+/g, "_");
    setConfigModel((prev) => {
      if (!prev) return prev;
      const updated = addProfile(prev, name, win.class);
      // Persist to daemon asynchronously (fire-and-forget; loadConfig will sync)
      setConfig(serializeConfigToml(updated)).catch(() => {});
      return updated;
    });
    setActiveProfile(name);
    setShowProfileModal(false);
  }, []);

  useEffect(() => {
    loadConfig();
    refreshStatus();

    const unlistenConn = onConnection((c) => {
      setConnected(c);
      if (c) {
        loadConfig();
        refreshStatus();
      }
    });

    const unlistenStatus = onStatus((s) => {
      setStatus(s);
      setConnected(true);
    });

    return () => {
      unlistenConn.then(([f1, f2]) => { f1(); f2(); });
      unlistenStatus.then((f) => f());
    };
  }, [loadConfig, refreshStatus]);

  // Keyboard shortcuts 1-4 to switch screens
  // Skip when modifier keys are held or when focus is in an editable element
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (target?.isContentEditable) return;
      const item = NAV_ITEMS.find((n) => n.key === e.key);
      if (item) setActiveScreen(item.id);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function renderScreen() {
    switch (activeScreen) {
      case "status":
        return <StatusScreen />;
      case "mappings":
        return (
          <MappingsScreen
            railActiveProfile={activeProfile}
            onProfilesChange={handleProfilesChange}
          />
        );
      case "key-tester":
        return <KeyTesterScreen />;
      case "devices":
        return <DevicesScreen />;
    }
  }

  const profiles = configModel ? listProfiles(configModel) : [];

  // Status bar values
  const daemonOk = connected === true;
  const activeProfileLabel = status?.active_profile ?? "—";
  const activeLayers = status?.active_layers ?? [];
  const layersLabel = activeLayers.length > 0 ? activeLayers.join(", ") : "base";
  const focusLabel = status?.focus ? status.focus.process : "—";
  const grabbedCount = status?.grabbed_devices?.length ?? 0;

  return (
    <div className="app-shell">
      <Titlebar connected={connected} />
      <div className="app-cols">
        {/* Left rail */}
        <aside className="rail" aria-label="Navigation">
          {/* Nav */}
          <nav className="rail__nav">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                className={`rail__nav-item${activeScreen === item.id ? " rail__nav-item--active" : ""}`}
                onClick={() => setActiveScreen(item.id)}
                aria-current={activeScreen === item.id ? "page" : undefined}
              >
                {item.label}
                <kbd className="rail__nav-kbd">{item.key}</kbd>
              </button>
            ))}
          </nav>

          {/* Profiles section — on every screen; clicking a profile jumps
              to Mappings with it selected. */}
          <div className="rail__section-label">Profiles</div>
          {profiles.map((name) => {
            const isActive = name === activeProfile && activeScreen === "mappings";
            const isLive = name === status?.active_profile;
            const matchLabel = configModel
              ? getProfileMatchLabel(configModel, name)
              : null;

            return (
              <button
                key={name}
                className={`rail__profile${isActive ? " rail__profile--active" : ""}`}
                onClick={() => {
                  setActiveProfile(name);
                  setActiveScreen("mappings");
                }}
              >
                <span>
                  {name}
                  {isLive && (
                    <span className="rail__profile-live"> ● active</span>
                  )}
                </span>
                {matchLabel && (
                  <span className="rail__profile-match">{matchLabel}</span>
                )}
              </button>
            );
          })}
          <button
            className="rail__add-profile"
            onClick={handleOpenAddProfile}
          >
            + new profile
          </button>
        </aside>

        {/* Main content */}
        <div className="main-area">{renderScreen()}</div>
      </div>

      {/* Profile add modal (lifted from MappingsScreen) */}
      {showProfileModal && (
        <div className="modal-backdrop" onClick={() => setShowProfileModal(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Select window for new profile"
          >
            <div className="modal__header">
              <span>Select window class</span>
              <button
                className="modal__close"
                onClick={() => setShowProfileModal(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="modal__body">
              {loadingWindows && <div className="muted">Loading windows…</div>}
              {windowError && <div className="banner--error">{windowError}</div>}
              {!loadingWindows && modalWindows.length === 0 && !windowError && (
                <div className="muted">No windows found.</div>
              )}
              <ul className="window-list">
                {modalWindows.map((win, idx) => (
                  <li key={idx}>
                    <button
                      className="window-list__item"
                      onClick={() => handleSelectWindow(win)}
                    >
                      <span className="window-list__class">{win.class}</span>
                      <span className="window-list__title muted"> — {win.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Bottom status bar (26px, mono 11px) */}
      <div className="status-bar" role="status" aria-label="Daemon status">
        <span>
          <span className={daemonOk ? "status-bar__dot--ok" : "status-bar__dot--err"}>
            ●
          </span>
          {" daemon"}
        </span>
        <span>
          profile:{" "}
          <span className="status-bar__val">{activeProfileLabel}</span>
        </span>
        <span>
          layers:{" "}
          <span className="status-bar__val">{layersLabel}</span>
        </span>
        <span>
          focus:{" "}
          <span className="status-bar__val">{focusLabel}</span>
        </span>
        <div className="status-bar__right">
          <span>
            grabbed:{" "}
            <span className="status-bar__val">{grabbedCount}</span>
          </span>
          <span>
            panic:{" "}
            <span className="status-bar__val">ctrl+alt+bsp</span>
          </span>
        </div>
      </div>
    </div>
  );
}

export default App;
