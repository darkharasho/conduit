import { useEffect, useState } from "react";
import { onConnection, onStatus, getConfig } from "./lib/client";
import type { Status } from "./lib/client";
import {
  parseConfigToml,
  listProfiles,
  getProfileMatchLabel,
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

  const loadConfig = async () => {
    try {
      const toml = await getConfig();
      const m = parseConfigToml(toml);
      setConfigModel(m);
    } catch {
      // Non-fatal
    }
  };

  useEffect(() => {
    loadConfig();

    const unlistenConn = onConnection((c) => {
      setConnected(c);
      if (c) loadConfig();
    });

    const unlistenStatus = onStatus((s) => {
      setStatus(s);
      setConnected(true);
    });

    return () => {
      unlistenConn.then(([f1, f2]) => { f1(); f2(); });
      unlistenStatus.then((f) => f());
    };
  }, []);

  // Keyboard shortcuts 1-4 to switch screens (skip when typing in an input)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
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
            onRailProfileChange={setActiveProfile}
            onProfilesChange={(names) => {
              // Re-fetch model when profiles change so rail shows fresh data
              loadConfig();
              // Ensure activeProfile is still valid
              if (!names.includes(activeProfile) && names.length > 0) {
                setActiveProfile(names[0]);
              }
            }}
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
      <div className="app-cols">
        {/* Left rail */}
        <aside className="rail" aria-label="Navigation">
          {/* Logo */}
          <div className="rail__logo">
            Conduit
            <span className="rail__logo-version">v0.1</span>
          </div>

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

          {/* Profiles section — only on Mappings screen */}
          {activeScreen === "mappings" && profiles.length > 0 && (
            <>
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
                    onClick={() => setActiveProfile(name)}
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
                onClick={() => {
                  document.dispatchEvent(
                    new CustomEvent("conduit:add-profile")
                  );
                }}
              >
                + new profile
              </button>
            </>
          )}
        </aside>

        {/* Main content */}
        <div className="main-area">{renderScreen()}</div>
      </div>

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
