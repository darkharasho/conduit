import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { getConfig, setConfig, onConnection, onKeyEvent, listDevices, listInstalledApps } from "../lib/client";
import type { DeviceInfo, ConduitError, InstalledApp } from "../lib/client";
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
  addProfile,
  actionWithEverywhereFallback,
  setProfileAutoSwitch,
  removeProfile,
} from "../lib/config-model";
import type { ConfigModel, ActionModel } from "../lib/config-model";
import { KeyboardViz } from "../components/KeyboardViz";
import { MouseViz } from "../components/MouseViz";
import { Toolbar } from "../components/Toolbar";
import { AssignPanel } from "../components/AssignPanel";
import { ProfileMatchEditor } from "../components/ProfileMatchEditor";
import { Toast } from "../components/Toast";
import type { ToastData } from "../components/Toast";
import { AppPillsBar } from "../components/AppPillsBar";
import { AppPicker } from "../components/AppPicker";
import { AppContextStrip } from "../components/AppContextStrip";
import { presentError } from "../lib/error-messages";
import { keyDisplayName, actionLabel } from "../lib/action-labels";
import { appPills } from "../lib/app-registry";

/** Lowercase, whitespace → underscore (mirrors old App.tsx handleSelectWindow logic) */
function slug(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "_");
}

interface Props {
  /** Rail-selected profile (controlled by App.tsx) */
  railActiveProfile: string;
  /** Notify App.tsx when profile list changes */
  onProfilesChange: (names: string[]) => void;
  /** The device to show in the editor. When absent, falls back to first grabbed device. No tab strip is rendered. */
  focusDevicePath?: string;
  /** Called when a new profile is selected in the pills bar */
  onSelectProfile?: (name: string) => void;
  /** Called when the user wants to navigate back (e.g. device was unplugged). App passes () => setView({kind:"home"}). */
  onBack?: () => void;
}

interface UndoFrame {
  prev: ConfigModel;
  description: string;
}

export function MappingsScreen({
  railActiveProfile,
  onProfilesChange,
  focusDevicePath,
  onSelectProfile,
  onBack,
}: Props) {
  const [model, setModel] = useState<ConfigModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeLayer, setActiveLayer] = useState("base");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [newLayerPrompt, setNewLayerPrompt] = useState(false);
  const [newLayerName, setNewLayerName] = useState("");
  const [toast, setToast] = useState<ToastData | null>(null);
  // Monotonically increasing id so each new toast gets a unique stable identity.
  const toastIdRef = useRef(0);

  // App picker state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);

  useEffect(() => {
    let alive = true;
    listInstalledApps()
      .then((apps) => { if (alive) setInstalledApps(apps); })
      .catch(() => {}); // pills degrade gracefully to class names
    return () => { alive = false; };
  }, []);

  // Grabbed devices (full list — used for deviceScope / device-override paths)
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  // True after the first listDevices() call completes (success or failure)
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  // "This device only" scope for saves (resets on key change)
  const [deviceScope, setDeviceScope] = useState(false);
  // Detect flow: waiting for a physical press on the active device
  const [detecting, setDetecting] = useState(false);

  // Undo stack: capped at 10 frames (in a ref — not state)
  const undoStackRef = useRef<UndoFrame[]>([]);

  // Hold onProfilesChange in a ref so loadConfig's deps stay stable
  const onProfilesChangeRef = useRef(onProfilesChange);
  useEffect(() => {
    onProfilesChangeRef.current = onProfilesChange;
  }, [onProfilesChange]);

  // Hold model in a ref so applyWithUndoImpl can read the current value at
  // call time without being in its deps (keeps the callback stable).
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  }, [model]);

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
    } catch {
      // Non-fatal: keyboard view without device context
    } finally {
      setDevicesLoaded(true);
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

  // Scope resets when the key changes
  useEffect(() => {
    setDeviceScope(false);
  }, [editingKey]);

  // Derive the active device: use focusDevicePath when given, else first grabbed device.
  // No tab strip — the active device is fixed for this editor session.
  const activeDevPath = focusDevicePath
    ? (devices.find((d) => d.path === focusDevicePath)?.path ?? null)
    : (devices[0]?.path ?? null);
  const activeDev = devices.find((d) => d.path === activeDevPath) ?? null;

  // When focusDevicePath was provided and the device list has loaded but the
  // device is absent (unplugged after the editor opened), show a recovery UI.
  const focusDeviceGone =
    !!focusDevicePath && devicesLoaded && !devices.some((d) => d.path === focusDevicePath);

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

  /**
   * Apply `updated` optimistically, persist, and offer Undo on success or
   * revert + Try-again on failure. `skipUndoPush` is used by the Undo action
   * itself so it does not push a new frame.
   */
  const applyWithUndoImpl = useCallback(
    async (updated: ConfigModel, description: string, skipUndoPush = false) => {
      // Read the current model via ref at call time — always fresh, avoids
      // stale-closure undo-stack corruption on the retry path.
      const prevSnapshot = modelRef.current;

      if (prevSnapshot !== null && !skipUndoPush) {
        const frame: UndoFrame = { prev: prevSnapshot, description };
        undoStackRef.current = [...undoStackRef.current, frame].slice(-10);
      }

      // Optimistic update
      setModel(updated);

      try {
        await setConfig(serializeConfigToml(updated));
        onProfilesChangeRef.current(listProfiles(updated));

        // Success toast with Undo
        setToast({
          id: ++toastIdRef.current,
          kind: "success",
          message: description,
          actionLabel: "Undo",
          onAction: () => {
            // Pop the frame we just pushed
            const stack = undoStackRef.current;
            if (stack.length === 0) return;
            const frame = stack[stack.length - 1];
            undoStackRef.current = stack.slice(0, -1);
            setToast(null);
            // Re-apply prev WITHOUT pushing a new undo frame
            applyWithUndoImpl(frame.prev, "Undone", true);
          },
        });
        return true;
      } catch (err) {
        // Revert optimistic update
        if (prevSnapshot !== null) {
          setModel(prevSnapshot);
        }
        // Pop the frame we pushed (if we did)
        if (!skipUndoPush && prevSnapshot !== null) {
          undoStackRef.current = undoStackRef.current.slice(0, -1);
        }

        const conduitErr = err as ConduitError;
        const presentation = presentError(conduitErr);

        setToast({
          id: ++toastIdRef.current,
          kind: "error",
          message: presentation.title,
          actionLabel: "Try again",
          onAction: () => {
            setToast(null);
            applyWithUndoImpl(updated, description, skipUndoPush);
          },
        });
        return false;
      }
    },
    [] // stable — reads current model via modelRef at call time
  );

  const handlePickApp = useCallback(
    async (name: string, matchClass: string) => {
      if (!modelRef.current) return;
      const profileName = slug(name);
      const updated = addProfile(modelRef.current, profileName, matchClass);
      setPickerOpen(false);
      await applyWithUndoImpl(updated, `${name} added`);
      onSelectProfile?.(profileName);
    },
    [applyWithUndoImpl, onSelectProfile]
  );

  const handlePickAdvanced = useCallback(
    async (name: string, match: Record<string, string>) => {
      if (!modelRef.current) return;
      const profileName = slug(name);
      // addProfile needs a class string; when the user gave no class but has
      // process/title, create with empty class then immediately overwrite the
      // match so the serialised TOML is correct.
      const withProfile = addProfile(modelRef.current, profileName, match.class ?? "");
      const updated = setProfileMatch(withProfile, profileName, match);
      setPickerOpen(false);
      await applyWithUndoImpl(updated, `${name} added`);
      onSelectProfile?.(profileName);
    },
    [applyWithUndoImpl, onSelectProfile]
  );

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

    let description: string;
    if (action.kind === "disabled") {
      description = "Button disabled";
    } else {
      description = `${keyDisplayName(editingKey)} now does ${actionLabel(action)}`;
    }

    await applyWithUndoImpl(updated, description);
  };

  // "Use default": remove whatever mapping is currently in effect for this
  // key — the device override when one shadows the profile, else the
  // profile mapping — so the button reverts to its normal job.
  // No-op (no toast, no setConfig) when the key has no mapping anywhere.
  const handleUseDefault = async () => {
    if (!model || !editingKey) return;
    const eff = getEffectiveAction(model, railActiveProfile, activeDev, activeLayer, editingKey);
    // Nothing mapped anywhere — skip entirely (don't write config, don't toast)
    if (!eff) return;
    const activePill = memoedPills.find(p => p.profileName === railActiveProfile);
    const isAppContext = activePill && activePill.kind !== "everywhere";

    if (eff?.source === "device" && activeDev) {
      const section = deviceSectionFor(model, railActiveProfile, activeDev);
      if (!section) return;
      await applyWithUndoImpl(
        removeDeviceAction(model, railActiveProfile, section, activeLayer, editingKey),
        "Back to its normal behavior"
      );
    } else {
      await applyWithUndoImpl(
        removeAction(model, railActiveProfile, activeLayer, editingKey),
        isAppContext ? "Back to the Everywhere setting" : "Back to its normal behavior"
      );
    }
  };

  const handleRemoveOverride = async () => {
    if (!model || !editingKey || !activeDev) return;
    const section = deviceSectionFor(model, railActiveProfile, activeDev);
    if (!section) return;
    await applyWithUndoImpl(
      removeDeviceAction(model, railActiveProfile, section, activeLayer, editingKey),
      "Back to its normal behavior"
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

  // Memoized app pills — recomputed only when model or installedApps change.
  // All four JSX consumers below receive this single derived value.
  const memoedPills = useMemo(
    () => (model ? appPills(model, installedApps) : []),
    [model, installedApps]
  );

  const layers = model ? listLayers(model, railActiveProfile) : ["base"];
  const effective = model && editingKey
    ? getEffectiveAction(model, railActiveProfile, activeDev, activeLayer, editingKey)
    : null;
  const currentAction = effective?.action ?? null;
  const isDeviceOverride = effective?.source === "device";

  // In app context (non-default profile), compute the display action using
  // actionWithEverywhereFallback so the panel header shows the inherited action
  // when the key is not set in the app profile (instead of "Normal job").
  // tomlEcho and all save/remove paths continue to use currentAction / effective.
  const displayAction = (() => {
    if (!model || !editingKey) return null;
    if (railActiveProfile === "default") return currentAction;
    const activePill = memoedPills.find(p => p.profileName === railActiveProfile);
    if (!activePill || activePill.kind === "everywhere") return currentAction;
    const withFallback = actionWithEverywhereFallback(model, railActiveProfile, activeDev, activeLayer, editingKey);
    return withFallback?.action ?? null;
  })();

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
            {/* App pills bar */}
            <AppPillsBar
              pills={memoedPills}
              active={railActiveProfile}
              onSelect={(name) => onSelectProfile?.(name)}
              onAdd={() => setPickerOpen(true)}
            />

            {/* App context strip — shown when an app/advanced profile is active */}
            {(() => {
              const activePill = memoedPills.find(p => p.profileName === railActiveProfile);
              if (!activePill || activePill.kind === "everywhere") return null;
              return (
                <AppContextStrip
                  pill={activePill}
                  onToggleAutoSwitch={(on) => {
                    const updated = setProfileAutoSwitch(model, railActiveProfile, on);
                    applyWithUndoImpl(updated, `Automatic switching ${on ? "on" : "off"} for ${activePill.label}`);
                  }}
                  onRemove={() => {
                    const updated = removeProfile(model, railActiveProfile);
                    applyWithUndoImpl(updated, `${activePill.label} settings removed`).then((ok) => {
                      if (ok) onSelectProfile?.("default");
                    });
                  }}
                />
              );
            })()}

            {/* Device disconnected message */}
            {focusDeviceGone && (
              <div className="banner--error" role="alert" style={{ margin: "8px 16px" }}>
                This device isn't connected anymore.{" "}
                <button className="btn" onClick={() => onBack?.()}>
                  Back to your devices
                </button>
              </div>
            )}

            {/* Detect bar — shown when a device is active */}
            {activeDev && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "2px 0 12px" }}>
                <button
                  className={`btn devtabs__detect${detecting ? " devtabs__detect--active" : ""}`}
                  onClick={() => setDetecting((v) => !v)}
                  title="Press a physical button/key on this device to jump to its mapping"
                >
                  Select by pressing
                </button>
                {detecting && (
                  <span className="devtabs__detect-hint">
                    …then press the button on your device
                  </span>
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
                  currentAction={displayAction}
                  tomlEcho={tomlEcho}
                  onSave={handleSaveAction}
                  onUseDefault={handleUseDefault}
                  onClose={() => setEditingKey(null)}
                  appContext={(() => {
                    const activePill = memoedPills.find(p => p.profileName === railActiveProfile);
                    if (!activePill || activePill.kind === "everywhere") return undefined;
                    const everywhereEff = actionWithEverywhereFallback(model, "default", activeDev, activeLayer, editingKey);
                    return {
                      label: activePill.label,
                      everywhereLabel: everywhereEff ? actionLabel(everywhereEff.action) : null,
                      isBrowser: activePill.isBrowser,
                    };
                  })()}
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
                    await applyWithUndoImpl(updated, "App match updated");
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

      {/* Toast notification */}
      {toast && (
        <Toast
          toast={toast}
          onDismiss={() => setToast(null)}
        />
      )}

      {/* App picker modal */}
      {pickerOpen && model && (
        <AppPicker
          model={model}
          onPick={handlePickApp}
          onPickAdvanced={handlePickAdvanced}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
