import { useCallback, useEffect, useState } from "react";
import {
  onConnection,
  onStatus,
  getConfig,
  getStatus,
  resume,
} from "./lib/client";
import type { Status } from "./lib/client";
import { Titlebar } from "./components/Titlebar";
import { SetupCheck } from "./components/SetupCheck";
import {
  parseConfigToml,
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
                    setView({ kind: "device", devPath: d.primaryPath, title: d.name })
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
              onSelectProfile={setActiveProfile}
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

    </div>
  );
}

export default App;
