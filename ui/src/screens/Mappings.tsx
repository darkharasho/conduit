import { useEffect, useState } from "react";
import { getConfig, setConfig, onConnection } from "../lib/client";
import {
  parseConfigToml,
  serializeConfigToml,
  setAction,
  addLayer,
  listLayers,
} from "../lib/config-model";
import type { ConfigModel, ActionModel } from "../lib/config-model";
import { ProfileList } from "../components/ProfileList";
import { KeyboardViz } from "../components/KeyboardViz";
import { ActionEditor } from "../components/ActionEditor";

export function MappingsScreen() {
  const [model, setModel] = useState<ConfigModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeProfile, setActiveProfile] = useState("default");
  const [activeLayer, setActiveLayer] = useState("base");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [newLayerPrompt, setNewLayerPrompt] = useState(false);
  const [newLayerName, setNewLayerName] = useState("");

  const loadConfig = async () => {
    try {
      const toml = await getConfig();
      const m = parseConfigToml(toml);
      setModel(m);
      setLoadError(null);
    } catch (err) {
      setLoadError(String(err));
    }
  };

  useEffect(() => {
    loadConfig();

    // Reload on reconnect
    const unlistenConn = onConnection((connected) => {
      if (connected) loadConfig();
    });

    return () => {
      unlistenConn.then(([fn1, fn2]) => {
        fn1();
        fn2();
      });
    };
  }, []);

  // When active profile changes, reset to base layer
  const handleSelectProfile = (name: string) => {
    setActiveProfile(name);
    setActiveLayer("base");
    setEditingKey(null);
  };

  const handleModelChange = async (updated: ConfigModel) => {
    setModel(updated);
    try {
      await setConfig(serializeConfigToml(updated));
    } catch {
      // Non-fatal: model is updated locally even if save fails
    }
  };

  const handleSaveAction = async (action: ActionModel): Promise<void> => {
    if (!model || !editingKey) return;
    const updated = setAction(model, activeProfile, activeLayer, editingKey, action);
    const toml = serializeConfigToml(updated);
    // This will throw if the daemon rejects it, and ActionEditor keeps itself open.
    await setConfig(toml);
    setModel(updated);
  };

  const handleAddLayer = () => {
    setNewLayerPrompt(true);
    setNewLayerName("");
  };

  const handleConfirmAddLayer = () => {
    const name = newLayerName.trim();
    if (!name || !model) {
      setNewLayerPrompt(false);
      return;
    }
    const updated = addLayer(model, activeProfile, name);
    setModel(updated);
    setActiveLayer(name);
    setNewLayerPrompt(false);
  };

  const layers = model ? listLayers(model, activeProfile) : ["base"];

  return (
    <div className="mappings-screen">
      {loadError && (
        <div className="banner banner--error" role="alert">
          Cannot load config: {loadError}
        </div>
      )}

      {model ? (
        <div className="mappings-layout">
          {/* Left rail: profile list */}
          <ProfileList
            model={model}
            activeProfile={activeProfile}
            onSelectProfile={handleSelectProfile}
            onModelChange={handleModelChange}
          />

          {/* Main area */}
          <div className="mappings-main">
            {/* Layer tabs */}
            <div className="layer-tabs" role="tablist" aria-label="Layers">
              {layers.map((layer) => (
                <button
                  key={layer}
                  role="tab"
                  aria-selected={layer === activeLayer}
                  className={`layer-tab${
                    layer === activeLayer ? " layer-tab--active" : ""
                  }`}
                  onClick={() => {
                    setActiveLayer(layer);
                    setEditingKey(null);
                  }}
                >
                  {layer}
                </button>
              ))}
              <button
                className="layer-tab layer-tab--add"
                onClick={handleAddLayer}
                aria-label="Add layer"
              >
                + layer
              </button>
            </div>

            {/* New layer prompt */}
            {newLayerPrompt && (
              <div className="new-layer-prompt">
                <input
                  className="field-input"
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
                <button
                  className="btn btn--primary"
                  onClick={handleConfirmAddLayer}
                >
                  Add
                </button>
                <button
                  className="btn btn--secondary"
                  onClick={() => setNewLayerPrompt(false)}
                >
                  Cancel
                </button>
              </div>
            )}

            {/* Keyboard visualization */}
            <div className="keyboard-container">
              <KeyboardViz
                model={model}
                activeProfile={activeProfile}
                activeLayer={activeLayer}
                selectedKey={editingKey}
                onSelectKey={(keyName) => {
                  setEditingKey((prev) =>
                    prev === keyName ? null : keyName
                  );
                }}
              />
            </div>

            {/* Action editor (inline panel below keyboard) */}
            {editingKey && (
              <div className="action-editor-container">
                <ActionEditor
                  keyName={editingKey}
                  model={model}
                  activeProfile={activeProfile}
                  activeLayer={activeLayer}
                  onSave={handleSaveAction}
                  onClose={() => setEditingKey(null)}
                />
              </div>
            )}
          </div>
        </div>
      ) : !loadError ? (
        <div className="status-placeholder">Loading config…</div>
      ) : null}
    </div>
  );
}
