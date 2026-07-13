import { useEffect, useRef, useState, useCallback } from "react";
import { getConfig, setConfig, onConnection, onKeyEvent, listDevices } from "../lib/client";
import type { DeviceInfo } from "../lib/client";
import {
  parseConfigToml,
  serializeConfigToml,
  setAction,
  addLayer,
  listLayers,
  listProfiles,
  getEffectiveAction,
  actionToTomlLine,
  setProfileMatch,
  setDeviceAction,
  removeAction,
  removeDeviceAction,
  deviceSectionFor,
  deviceSectionKey,
  selectorMatches,
} from "../lib/config-model";
import type { ConfigModel, ActionModel } from "../lib/config-model";
import { KeyboardViz } from "../components/KeyboardViz";
import { MouseViz } from "../components/MouseViz";
import { Toolbar } from "../components/Toolbar";
import { AssignPanel } from "../components/AssignPanel";
import { ProfileMatchEditor } from "../components/ProfileMatchEditor";

interface Props {
  /** Rail-selected profile (controlled by App.tsx rail) */
  railActiveProfile: string;
  /** Notify App.tsx when profile list changes */
  onProfilesChange: (names: string[]) => void;
}

export function MappingsScreen({
  railActiveProfile,
  onProfilesChange,
}: Props) {
  const [model, setModel] = useState<ConfigModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeLayer, setActiveLayer] = useState("base");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [newLayerPrompt, setNewLayerPrompt] = useState(false);
  const [newLayerName, setNewLayerName] = useState("");

  // Device tabs: grabbed devices, keyed by evdev path (unique even for twins)
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [activeDevPath, setActiveDevPath] = useState<string | null>(null);
  // "This device only" scope for saves (resets on key/tab change)
  const [deviceScope, setDeviceScope] = useState(false);
  // Detect flow: waiting for a physical press on the active device
  const [detecting, setDetecting] = useState(false);

  // Hold onProfilesChange in a ref so loadConfig's deps stay stable
  const onProfilesChangeRef = useRef(onProfilesChange);
  useEffect(() => {
    onProfilesChangeRef.current = onProfilesChange;
  }, [onProfilesChange]);

  const loadConfig = useCallback(async () => {
    try {
      const toml = await getConfig();
      const m = parseConfigToml(toml);
      setModel(m);
      setLoadError(null);
      onProfilesChangeRef.current(listProfiles(m));
    } catch (err) {
      setLoadError(String(err));
    }
  }, []); // stable — no external deps

  const loadDevices = useCallback(async () => {
    try {
      const devs = (await listDevices()).filter((d) => d.grabbed);
      setDevices(devs);
      setActiveDevPath((prev) =>
        prev && devs.some((d) => d.path === prev) ? prev : devs[0]?.path ?? null
      );
    } catch {
      // Non-fatal: no tabs, keyboard view without device context
    }
  }, []);

  useEffect(() => {
    loadConfig();
    loadDevices();

    const unlistenConn = onConnection((connected) => {
      if (connected) {
        loadConfig();
        loadDevices();
      }
    });

    return () => {
      unlistenConn.then(([fn1, fn2]) => { fn1(); fn2(); });
    };
  }, [loadConfig, loadDevices]);

  // When rail selects a different profile, reset layer & editing
  useEffect(() => {
    setActiveLayer("base");
    setEditingKey(null);
  }, [railActiveProfile]);

  // Scope resets when the key or tab changes
  useEffect(() => {
    setDeviceScope(false);
  }, [editingKey, activeDevPath]);

  const activeDev = devices.find((d) => d.path === activeDevPath) ?? null;

  // Detect: select the first key pressed on the active device. HID
  // descriptors over-declare wildly (a 9-button mouse can declare 300
  // codes), so pressing the real button is the only reliable identifier.
  const activeDevName = activeDev?.name ?? null;
  useEffect(() => {
    if (!detecting || !activeDevName) return;
    let done = false;
    const unlisten = onKeyEvent((ev) => {
      if (done) return;
      if (ev.phase === "pre" && ev.state === "press" && ev.device === activeDevName) {
        done = true;
        setEditingKey(ev.key_name);
        setDetecting(false);
      }
    });
    const timeout = setTimeout(() => setDetecting(false), 10_000);
    return () => {
      done = true;
      clearTimeout(timeout);
      unlisten.then((f) => f());
    };
  }, [detecting, activeDevName]);

  // Offline sections: device selectors in this profile with no grabbed match
  const profileModel = model?.profiles.find((p) => p.name === railActiveProfile);
  const offlineSections = Object.keys(profileModel?.device ?? {}).filter(
    (sel) => !devices.some((d) => selectorMatches(sel, d))
  );

  const persist = async (updated: ConfigModel) => {
    setModel(updated);
    try {
      await setConfig(serializeConfigToml(updated));
    } catch (err) {
      setLoadError(String(err));
      return;
    }
    onProfilesChangeRef.current(listProfiles(updated));
  };

  const handleSaveAction = async (action: ActionModel): Promise<void> => {
    if (!model || !editingKey) return;
    const updated =
      deviceScope && activeDev
        ? setDeviceAction(
            model,
            railActiveProfile,
            deviceSectionFor(model, railActiveProfile, activeDev) ??
              deviceSectionKey(activeDev, devices),
            activeLayer,
            editingKey,
            action
          )
        : setAction(model, railActiveProfile, activeLayer, editingKey, action);
    await persist(updated);
  };

  // "Use default": remove whatever mapping is currently in effect for this
  // key — the device override when one shadows the profile, else the
  // profile mapping — so the button reverts to its normal job.
  const handleUseDefault = async () => {
    if (!model || !editingKey) return;
    const eff = getEffectiveAction(model, railActiveProfile, activeDev, activeLayer, editingKey);
    if (eff?.source === "device" && activeDev) {
      const section = deviceSectionFor(model, railActiveProfile, activeDev);
      if (!section) return;
      await persist(
        removeDeviceAction(model, railActiveProfile, section, activeLayer, editingKey)
      );
    } else {
      await persist(removeAction(model, railActiveProfile, activeLayer, editingKey));
    }
  };

  const handleRemoveOverride = async () => {
    if (!model || !editingKey || !activeDev) return;
    const section = deviceSectionFor(model, railActiveProfile, activeDev);
    if (!section) return;
    await persist(
      removeDeviceAction(model, railActiveProfile, section, activeLayer, editingKey)
    );
  };

  const handleAddLayer = () => {
    setNewLayerPrompt(true);
    setNewLayerName("");
  };

  const handleConfirmAddLayer = async () => {
    const name = newLayerName.trim();
    if (!name || !model) {
      setNewLayerPrompt(false);
      return;
    }
    const updated = addLayer(model, railActiveProfile, name);
    setModel(updated);
    try {
      await setConfig(serializeConfigToml(updated));
    } catch (err) {
      setLoadError(String(err));
      return;
    }
    setActiveLayer(name);
    setNewLayerPrompt(false);
  };

  const layers = model ? listLayers(model, railActiveProfile) : ["base"];
  const effective = model && editingKey
    ? getEffectiveAction(model, railActiveProfile, activeDev, activeLayer, editingKey)
    : null;
  const currentAction = effective?.action ?? null;
  const isDeviceOverride = effective?.source === "device";

  // TOML echo for inspector footer
  const tomlEcho = model && editingKey && currentAction
    ? actionToTomlLine(railActiveProfile, activeLayer, editingKey, currentAction)
    : null;

  const isPointerClass = (cls: string) => cls === "mouse" || cls === "touchpad";

  return (
    <div className="screen-shell">
      {/* Toolbar */}
      <Toolbar title="Mappings" sub={` — ${railActiveProfile}`}>
        {/* Layer segment control */}
        <div className="seg" role="tablist" aria-label="Layers" style={{ marginLeft: 14 }}>
          {layers.map((layer) => (
            <button
              key={layer}
              role="tab"
              aria-selected={layer === activeLayer}
              className={`seg__btn${layer === activeLayer ? " seg__btn--active" : ""}`}
              onClick={() => {
                setActiveLayer(layer);
                setEditingKey(null);
              }}
            >
              {layer}
            </button>
          ))}
          <button
            className="seg__btn"
            onClick={handleAddLayer}
            aria-label="Add layer"
            title="Add layer"
          >
            +
          </button>
        </div>
      </Toolbar>

      {/* Error banner */}
      {loadError && (
        <div className="banner--error" role="alert" style={{ margin: "8px 16px" }}>
          Cannot load config: {loadError}
        </div>
      )}

      {/* Content */}
      <div className="screen-content">
        {model ? (
          <>
            {/* Device tabs */}
            {(devices.length > 0 || offlineSections.length > 0) && (
              <div className="devtabs" role="tablist" aria-label="Devices">
                {devices.map((d) => (
                  <button
                    key={d.path}
                    role="tab"
                    aria-selected={d.path === activeDevPath}
                    className={`devtab${d.path === activeDevPath ? " devtab--active" : ""}`}
                    onClick={() => {
                      setActiveDevPath(d.path);
                      setEditingKey(null);
                    }}
                  >
                    <span>{d.name}</span>
                    <span className="devtab__cls">{d.class.toUpperCase()}</span>
                  </button>
                ))}
                {offlineSections.map((sel) => (
                  <span key={sel} className="devtab devtab--offline" title="Device not connected; overrides preserved">
                    <span>{sel}</span>
                    <span className="devtab__cls">OFFLINE</span>
                  </span>
                ))}
                {activeDev && (
                  <button
                    className={`btn devtabs__detect${detecting ? " devtabs__detect--active" : ""}`}
                    onClick={() => setDetecting((v) => !v)}
                    title="Press a physical button/key on this device to jump to its mapping"
                  >
                    {detecting ? `press a button on ${activeDev.name}…` : "Detect button"}
                  </button>
                )}
              </div>
            )}

            {/* New layer prompt */}
            {newLayerPrompt && (
              <div className="new-layer-prompt">
                <input
                  className="new-layer-input"
                  type="text"
                  placeholder="layer name"
                  value={newLayerName}
                  onChange={(e) => setNewLayerName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleConfirmAddLayer();
                    if (e.key === "Escape") setNewLayerPrompt(false);
                  }}
                  autoFocus
                />
                <button className="btn btn--primary" onClick={handleConfirmAddLayer}>
                  Add
                </button>
                <button className="btn" onClick={() => setNewLayerPrompt(false)}>
                  Cancel
                </button>
              </div>
            )}

            {/* Visualization: mouse diagram for pointer devices, ANSI board otherwise */}
            {activeDev && isPointerClass(activeDev.class) ? (
              <MouseViz
                model={model}
                activeProfile={railActiveProfile}
                activeLayer={activeLayer}
                selectedKey={editingKey}
                onSelectKey={(keyName) => {
                  setEditingKey((prev) => (prev === keyName ? null : keyName));
                }}
                dev={activeDev}
              />
            ) : (
              <KeyboardViz
                model={model}
                activeProfile={railActiveProfile}
                activeLayer={activeLayer}
                selectedKey={editingKey}
                onSelectKey={(keyName) => {
                  setEditingKey((prev) => (prev === keyName ? null : keyName));
                }}
                dev={activeDev}
              />
            )}

            {/* Inline inspector panel */}
            {editingKey ? (
              <>
                {activeDev && (
                  <div className="scope-bar">
                    <label className="scope-bar__toggle">
                      <input
                        type="checkbox"
                        checked={deviceScope}
                        onChange={(e) => setDeviceScope(e.target.checked)}
                      />
                      {" This device only ("}
                      <span className="mono">{activeDev.name}</span>
                      {")"}
                    </label>
                    {isDeviceOverride && (
                      <button className="btn" onClick={handleRemoveOverride}>
                        Remove override
                      </button>
                    )}
                    {isDeviceOverride && (
                      <span className="scope-bar__badge">device-specific</span>
                    )}
                  </div>
                )}
                <AssignPanel
                  key={`${editingKey}:${railActiveProfile}:${activeLayer}:${activeDevPath}`}
                  keyName={editingKey}
                  model={model}
                  activeProfile={railActiveProfile}
                  activeLayer={activeLayer}
                  currentAction={currentAction}
                  tomlEcho={tomlEcho}
                  onSave={handleSaveAction}
                  onUseDefault={handleUseDefault}
                  onClose={() => setEditingKey(null)}
                />
              </>
            ) : (
              <>
                <ProfileMatchEditor
                  key={railActiveProfile}
                  model={model}
                  profileName={railActiveProfile}
                  onApply={async (match) => {
                    const updated = setProfileMatch(model, railActiveProfile, match);
                    await persist(updated);
                  }}
                />
                <div className="inspector">
                  <div className="inspector__hint">
                    Click a button above to change what it does.
                  </div>
                </div>
              </>
            )}
          </>
        ) : !loadError ? (
          <span className="muted">Loading config…</span>
        ) : null}
      </div>
    </div>
  );
}
