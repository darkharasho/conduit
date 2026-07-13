import { useCallback, useEffect, useState } from "react";
import {
  onConnection,
  onStatus,
  getConfig,
  setConfig,
  getStatus,
  resume,
  listWindows,
} from "./lib/client";
import type { Status, FocusInfo } from "./lib/client";
import { Titlebar } from "./components/Titlebar";
import { SetupCheck } from "./components/SetupCheck";
import {
  parseConfigToml,
  serializeConfigToml,
  listProfiles,
  getProfileMatchLabel,
  addProfile,
} from "./lib/config-model";
import type { ConfigModel } from "./lib/config-model";
import { MappingsScreen } from "./screens/Mappings";
import { HomeScreen } from "./screens/Home";
import { HelpScreen } from "./screens/Help";
import type { PhysicalDevice } from "./lib/device-registry";

type View =
  | { kind: "home" }
  | { kind: "device"; devPath: string; title: string }
  | { kind: "help" };

function App() {
  const [view, setView] = useState<View>({ kind: "home" });
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
  // a stale state until the next status push.
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

  const profiles = configModel ? listProfiles(configModel) : [];

  const isDeviceView = view.kind === "device";

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="app-body">
        {status?.suspended === true && (
          <div className="pause-banner" role="status">
            <span>Conduit is paused — your buttons have their normal behavior.</span>
            <button className="btn" onClick={() => resume().catch(() => {})}>Resume</button>
          </div>
        )}
        <div className={`app-cols${isDeviceView ? "" : " app--no-rail"}`}>
        {/* Left rail — only in device view */}
        {isDeviceView && view.kind === "device" && (
          <aside className="rail" aria-label="Navigation">
            {/* Back button */}
            <button className="rail__back" onClick={() => setView({ kind: "home" })}>
              ‹ Your devices
            </button>
            <div className="rail__device-title">{view.title}</div>

            {/* Profiles section — clicking a profile jumps to Mappings with it selected.
                The technical match rule stays available as a tooltip; the rail speaks plainly. */}
            <div className="rail__section-label">Profiles</div>
            {profiles.map((name) => {
              const isActive = name === activeProfile;
              const isLive = name === status?.active_profile;
              const matchLabel = configModel
                ? getProfileMatchLabel(configModel, name)
                : null;

              return (
                <button
                  key={name}
                  className={`rail__profile${isActive ? " rail__profile--active" : ""}`}
                  title={matchLabel ?? undefined}
                  onClick={() => {
                    setActiveProfile(name);
                  }}
                >
                  <span>
                    {name === "default" ? "Everywhere" : name}
                    {isLive && (
                      <span className="rail__profile-live"> ● active</span>
                    )}
                  </span>
                  {matchLabel && (
                    <span className="rail__profile-auto">AUTO</span>
                  )}
                </button>
              );
            })}
            <button
              className="rail__add-profile"
              onClick={handleOpenAddProfile}
            >
              + Profile for an app…
            </button>
            <p className="rail__profiles-hint">
              App profiles switch on by themselves when their app is in front.
            </p>
          </aside>
        )}

        {/* Main content */}
        <div className="main-area">
          {view.kind === "home" && (
            connected === false ? (
              <div className="home-shell__recovery"><SetupCheck /></div>
            ) : (
              <>
                <HomeScreen
                  model={configModel}
                  connected={connected}
                  onOpenDevice={(d: PhysicalDevice) =>
                    setView({ kind: "device", devPath: d.nodes[0].path, title: d.name })
                  }
                />
                <button className="home-shell__help-link" onClick={() => setView({ kind: "help" })}>
                  Help & troubleshooting
                </button>
              </>
            )
          )}
          {view.kind === "device" && (
            <MappingsScreen
              railActiveProfile={activeProfile}
              onProfilesChange={handleProfilesChange}
              focusDevicePath={view.devPath}
            />
          )}
          {view.kind === "help" && (
            <div className="home-shell__help">
              <button className="home-shell__back" onClick={() => setView({ kind: "home" })}>‹ Your devices</button>
              <HelpScreen />
            </div>
          )}
        </div>
      </div>
      </div>

      {/* Profile add modal (lifted from MappingsScreen) */}
      {showProfileModal && (
        <div className="modal-backdrop" onClick={() => setShowProfileModal(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Profile for an app"
          >
            <div className="modal__header">
              <span>Profile for an app</span>
              <button
                className="modal__close"
                onClick={() => setShowProfileModal(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="modal__body">
              <p className="modal__sub">
                Pick an app that&apos;s open right now. Its profile switches on
                whenever you&apos;re using that app, and off when you leave.
              </p>
              {loadingWindows && <div className="muted">Looking at your open apps…</div>}
              {windowError && <div className="banner--error">{windowError}</div>}
              {!loadingWindows && modalWindows.length === 0 && !windowError && (
                <div className="muted">
                  No open apps found. Open the app you want a profile for, then
                  try again.
                </div>
              )}
              <ul className="window-list">
                {modalWindows.map((win, idx) => {
                  const taken = configModel?.profiles.some(
                    (p) =>
                      p.match?.["class"]?.toLowerCase() === win.class.toLowerCase()
                  );
                  return (
                    <li key={idx}>
                      <button
                        className="window-list__item"
                        disabled={taken}
                        onClick={() => handleSelectWindow(win)}
                      >
                        <span className="window-list__class">{win.class}</span>
                        <span className="window-list__title muted">
                          {" "}
                          — {taken ? "already has a profile" : win.title}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
