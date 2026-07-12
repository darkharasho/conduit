import { useEffect, useRef, useState, useCallback } from "react";
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
  setProfileMatch,
} from "../lib/config-model";
import type { ConfigModel, ActionModel } from "../lib/config-model";
import { KeyboardViz } from "../components/KeyboardViz";
import { Toolbar } from "../components/Toolbar";
import { InspectorPanel } from "../components/InspectorPanel";
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

  useEffect(() => {
    loadConfig();

    const unlistenConn = onConnection((connected) => {
      if (connected) loadConfig();
    });

    return () => {
      unlistenConn.then(([fn1, fn2]) => { fn1(); fn2(); });
    };
  }, [loadConfig]);

  // When rail selects a different profile, reset layer & editing
  useEffect(() => {
    setActiveLayer("base");
    setEditingKey(null);
  }, [railActiveProfile]);

  const handleSaveAction = async (action: ActionModel): Promise<void> => {
    if (!model || !editingKey) return;
    const updated = setAction(model, railActiveProfile, activeLayer, editingKey, action);
    const toml = serializeConfigToml(updated);
    await setConfig(toml);
    setModel(updated);
    onProfilesChangeRef.current(listProfiles(updated));
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
  const currentAction = model && editingKey
    ? getAction(model, railActiveProfile, activeLayer, editingKey)
    : null;

  // TOML echo for inspector footer
  const tomlEcho = model && editingKey && currentAction
    ? actionToTomlLine(railActiveProfile, activeLayer, editingKey, currentAction)
    : null;

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
              <>
                <ProfileMatchEditor
                  key={railActiveProfile}
                  model={model}
                  profileName={railActiveProfile}
                  onApply={async (match) => {
                    const updated = setProfileMatch(model, railActiveProfile, match);
                    setModel(updated);
                    try {
                      await setConfig(serializeConfigToml(updated));
                    } catch (err) {
                      setLoadError(String(err));
                    }
                  }}
                />
                <div className="inspector">
                  <div className="inspector__hint">
                    Select a key above to edit its mapping.
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
