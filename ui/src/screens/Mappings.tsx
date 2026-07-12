import { useEffect, useState, useCallback } from "react";
import { getConfig, setConfig, onConnection } from "../lib/client";
import {
  parseConfigToml,
  serializeConfigToml,
  setAction,
  addLayer,
  listLayers,
  listProfiles,
  getAction,
  actionToTomlLine,
} from "../lib/config-model";
import type { ConfigModel, ActionModel } from "../lib/config-model";
import { KeyboardViz } from "../components/KeyboardViz";
import { Toolbar } from "../components/Toolbar";
import { InspectorPanel } from "../components/InspectorPanel";
import { listWindows } from "../lib/client";
import { addProfile } from "../lib/config-model";
import type { FocusInfo } from "../lib/client";

interface Props {
  /** Rail-selected profile (controlled by App.tsx rail) */
  railActiveProfile: string;
  /** Notify App.tsx when profile selection changes */
  onRailProfileChange: (name: string) => void;
  /** Notify App.tsx when profile list changes */
  onProfilesChange: (names: string[]) => void;
}

export function MappingsScreen({
  railActiveProfile,
  onRailProfileChange,
  onProfilesChange,
}: Props) {
  const [model, setModel] = useState<ConfigModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeLayer, setActiveLayer] = useState("base");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [newLayerPrompt, setNewLayerPrompt] = useState(false);
  const [newLayerName, setNewLayerName] = useState("");

  // Profile add modal state
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [modalWindows, setModalWindows] = useState<FocusInfo[]>([]);
  const [loadingWindows, setLoadingWindows] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);

  const loadConfig = useCallback(async () => {
    try {
      const toml = await getConfig();
      const m = parseConfigToml(toml);
      setModel(m);
      setLoadError(null);
      onProfilesChange(listProfiles(m));
    } catch (err) {
      setLoadError(String(err));
    }
  }, [onProfilesChange]);

  useEffect(() => {
    loadConfig();

    const unlistenConn = onConnection((connected) => {
      if (connected) loadConfig();
    });

    // Listen for rail "add profile" trigger from App.tsx
    const handleAddProfile = () => openProfileModal();
    document.addEventListener("conduit:add-profile", handleAddProfile);

    return () => {
      unlistenConn.then(([fn1, fn2]) => { fn1(); fn2(); });
      document.removeEventListener("conduit:add-profile", handleAddProfile);
    };
  }, [loadConfig]);

  // When rail selects a different profile, reset layer & editing
  useEffect(() => {
    setActiveLayer("base");
    setEditingKey(null);
  }, [railActiveProfile]);

  const handleModelChange = async (updated: ConfigModel) => {
    setModel(updated);
    onProfilesChange(listProfiles(updated));
    try {
      await setConfig(serializeConfigToml(updated));
    } catch {
      // Non-fatal: model is updated locally even if save fails
    }
  };

  const handleSaveAction = async (action: ActionModel): Promise<void> => {
    if (!model || !editingKey) return;
    const updated = setAction(model, railActiveProfile, activeLayer, editingKey, action);
    const toml = serializeConfigToml(updated);
    await setConfig(toml);
    setModel(updated);
    onProfilesChange(listProfiles(updated));
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

  // Profile modal handlers
  const openProfileModal = async () => {
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
  };

  const handleSelectWindow = (win: FocusInfo) => {
    if (!model) return;
    const name = win.class.toLowerCase().replace(/\s+/g, "_");
    const updated = addProfile(model, name, win.class);
    handleModelChange(updated);
    onRailProfileChange(name);
    setShowProfileModal(false);
  };

  const layers = model ? listLayers(model, railActiveProfile) : ["base"];
  const currentAction = model && editingKey
    ? getAction(model, railActiveProfile, activeLayer, editingKey)
    : null;

  // TOML echo for inspector footer
  const tomlEcho = model && editingKey && currentAction
    ? actionToTomlLine(railActiveProfile, activeLayer, editingKey, currentAction)
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
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

            {/* Keyboard visualization */}
            <KeyboardViz
              model={model}
              activeProfile={railActiveProfile}
              activeLayer={activeLayer}
              selectedKey={editingKey}
              onSelectKey={(keyName) => {
                setEditingKey((prev) => (prev === keyName ? null : keyName));
              }}
            />

            {/* Inline inspector panel */}
            {editingKey ? (
              <InspectorPanel
                key={`${editingKey}:${railActiveProfile}:${activeLayer}`}
                keyName={editingKey}
                model={model}
                activeProfile={railActiveProfile}
                activeLayer={activeLayer}
                tomlEcho={tomlEcho}
                onSave={handleSaveAction}
                onClose={() => setEditingKey(null)}
              />
            ) : (
              <div className="inspector">
                <div className="inspector__hint">
                  Select a key above to edit its mapping.
                </div>
              </div>
            )}
          </>
        ) : !loadError ? (
          <span className="muted">Loading config…</span>
        ) : null}
      </div>

      {/* Profile add modal */}
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
    </div>
  );
}
