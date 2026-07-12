import { useState, useEffect } from "react";
import type { ActionModel, ConfigModel } from "../lib/config-model";
import { getAction, listLayers } from "../lib/config-model";
import { captureNextKey } from "../lib/client";

interface Props {
  keyName: string;
  model: ConfigModel;
  activeProfile: string;
  activeLayer: string;
  onSave: (action: ActionModel) => Promise<void>;
  onClose: () => void;
}

type Kind = ActionModel["kind"];

const KIND_LABELS: { id: Kind; label: string }[] = [
  { id: "key", label: "Remap" },
  { id: "taphold", label: "Tap-Hold" },
  { id: "layer_toggle", label: "Layer toggle" },
  { id: "disabled", label: "Disable" },
  { id: "passthrough", label: "Passthrough" },
];

function useCaptureKey(
  initial: string
): [string, boolean, () => Promise<void>] {
  const [value, setValue] = useState(initial);
  const [capturing, setCapturing] = useState(false);

  const capture = async () => {
    setCapturing(true);
    try {
      const result = await captureNextKey();
      setValue(result.name);
    } catch {
      // ignore — daemon may not be running in dev
    } finally {
      setCapturing(false);
    }
  };

  return [value, capturing, capture];
}

export function ActionEditor({
  keyName,
  model,
  activeProfile,
  activeLayer,
  onSave,
  onClose,
}: Props) {
  const existingAction = getAction(model, activeProfile, activeLayer, keyName);

  const initialKind: Kind = existingAction?.kind ?? "key";
  const [kind, setKind] = useState<Kind>(initialKind);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Remap fields
  const [remapKey, remapCapturing, captureRemapKey] = useCaptureKey(
    existingAction?.kind === "key" ? existingAction.key : ""
  );

  // Tap-hold fields
  const [tapKey, tapCapturing, captureTapKey] = useCaptureKey(
    existingAction?.kind === "taphold" ? existingAction.tap : ""
  );
  const [holdKey, holdCapturing, captureHoldKey] = useCaptureKey(
    existingAction?.kind === "taphold" ? existingAction.hold : ""
  );
  const [holdIsLayer, setHoldIsLayer] = useState(
    existingAction?.kind === "taphold" &&
      existingAction.hold.startsWith("layer:")
  );
  const [holdLayerName, setHoldLayerName] = useState(
    existingAction?.kind === "taphold" && existingAction.hold.startsWith("layer:")
      ? existingAction.hold.slice(6)
      : ""
  );
  const [timeoutMs, setTimeoutMs] = useState<string>(
    existingAction?.kind === "taphold" && existingAction.timeoutMs !== undefined
      ? String(existingAction.timeoutMs)
      : ""
  );

  // Layer toggle fields
  const [toggleLayer, setToggleLayer] = useState(
    existingAction?.kind === "layer_toggle" ? existingAction.layer : ""
  );

  const layers = listLayers(model, activeProfile).filter((l) => l !== "base");

  // Sync kind from external prop on key change
  useEffect(() => {
    const a = getAction(model, activeProfile, activeLayer, keyName);
    setKind(a?.kind ?? "key");
    setSaveError(null);
  }, [keyName, activeProfile, activeLayer]);

  const buildAction = (): ActionModel | null => {
    switch (kind) {
      case "key":
        if (!remapKey) return null;
        return { kind: "key", key: remapKey };
      case "taphold": {
        if (!tapKey) return null;
        const hold = holdIsLayer ? `layer:${holdLayerName}` : holdKey;
        if (!hold) return null;
        const action: ActionModel = { kind: "taphold", tap: tapKey, hold };
        const ms = parseInt(timeoutMs, 10);
        if (!isNaN(ms) && ms > 0) {
          return { ...action, timeoutMs: ms };
        }
        return action;
      }
      case "layer_toggle":
        if (!toggleLayer) return null;
        return { kind: "layer_toggle", layer: toggleLayer };
      case "disabled":
        return { kind: "disabled" };
      case "passthrough":
        return { kind: "passthrough" };
    }
  };

  const handleSave = async () => {
    const action = buildAction();
    if (!action) {
      setSaveError("Please fill in all required fields.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(action);
      onClose();
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="action-editor" role="dialog" aria-modal="true" aria-label={`Edit mapping for ${keyName}`}>
      <div className="action-editor__header">
        <span className="action-editor__key-name">{keyName}</span>
        <button className="modal__close" onClick={onClose} aria-label="Close editor">
          ×
        </button>
      </div>

      <div className="action-editor__body">
        {/* Kind selector */}
        <div className="action-editor__kinds">
          {KIND_LABELS.map(({ id, label }) => (
            <label key={id} className="action-editor__kind-label">
              <input
                type="radio"
                name="kind"
                value={id}
                checked={kind === id}
                onChange={() => {
                  setKind(id);
                  setSaveError(null);
                }}
              />
              {label}
            </label>
          ))}
        </div>

        {/* Fields for each kind */}
        <div className="action-editor__fields">
          {kind === "key" && (
            <div className="field-row">
              <label className="field-label">Key</label>
              <div className="capture-field">
                <span className="capture-field__value">
                  {remapKey || <span className="muted">not set</span>}
                </span>
                <button
                  className="btn btn--secondary capture-btn"
                  onClick={captureRemapKey}
                  disabled={remapCapturing}
                >
                  {remapCapturing ? "Press a key…" : "Capture key"}
                </button>
              </div>
            </div>
          )}

          {kind === "taphold" && (
            <>
              <div className="field-row">
                <label className="field-label">Tap</label>
                <div className="capture-field">
                  <span className="capture-field__value">
                    {tapKey || <span className="muted">not set</span>}
                  </span>
                  <button
                    className="btn btn--secondary capture-btn"
                    onClick={captureTapKey}
                    disabled={tapCapturing}
                  >
                    {tapCapturing ? "Press a key…" : "Capture key"}
                  </button>
                </div>
              </div>

              <div className="field-row">
                <label className="field-label">Hold</label>
                <div className="capture-field">
                  <label className="field-checkbox">
                    <input
                      type="checkbox"
                      checked={holdIsLayer}
                      onChange={(e) => setHoldIsLayer(e.target.checked)}
                    />
                    Layer
                  </label>
                  {holdIsLayer ? (
                    <select
                      className="field-select"
                      value={holdLayerName}
                      onChange={(e) => setHoldLayerName(e.target.value)}
                    >
                      <option value="">-- select layer --</option>
                      {layers.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <>
                      <span className="capture-field__value">
                        {holdKey || <span className="muted">not set</span>}
                      </span>
                      <button
                        className="btn btn--secondary capture-btn"
                        onClick={captureHoldKey}
                        disabled={holdCapturing}
                      >
                        {holdCapturing ? "Press a key…" : "Capture key"}
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="field-row">
                <label className="field-label">Timeout (ms)</label>
                <input
                  type="number"
                  className="field-input"
                  placeholder="default"
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(e.target.value)}
                  min={1}
                />
              </div>
            </>
          )}

          {kind === "layer_toggle" && (
            <div className="field-row">
              <label className="field-label">Layer</label>
              <select
                className="field-select"
                value={toggleLayer}
                onChange={(e) => setToggleLayer(e.target.value)}
              >
                <option value="">-- select layer --</option>
                {layers.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
          )}

          {(kind === "disabled" || kind === "passthrough") && (
            <p className="muted action-editor__no-fields">
              No additional settings for this action type.
            </p>
          )}
        </div>

        {/* Error */}
        {saveError && (
          <div className="action-error" role="alert">
            {saveError}
          </div>
        )}

        {/* Actions */}
        <div className="action-editor__footer">
          <button
            className="btn btn--primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
