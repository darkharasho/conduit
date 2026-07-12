import { useState, useEffect, useCallback } from "react";
import type { ActionModel, ConfigModel } from "../lib/config-model";
import { getAction, listLayers, actionToTomlLine } from "../lib/config-model";
import { captureNextKey } from "../lib/client";

interface Props {
  keyName: string;
  model: ConfigModel;
  activeProfile: string;
  activeLayer: string;
  /** Pre-computed TOML echo line for the current saved action */
  tomlEcho: string | null;
  onSave: (action: ActionModel) => Promise<void>;
  onClose: () => void;
}

type Kind = ActionModel["kind"];

const KIND_LABELS: { id: Kind; label: string }[] = [
  { id: "key",          label: "remap"    },
  { id: "taphold",      label: "tap-hold" },
  { id: "layer_toggle", label: "layer"    },
  { id: "disabled",     label: "disable"  },
  { id: "passthrough",  label: "pass"     },
];

function useCaptureKey(initial: string): [string, (v: string) => void, boolean, () => Promise<void>] {
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

  return [value, setValue, capturing, capture];
}

export function InspectorPanel({
  keyName,
  model,
  activeProfile,
  activeLayer,
  tomlEcho,
  onSave,
  onClose,
}: Props) {
  const existingAction = getAction(model, activeProfile, activeLayer, keyName);

  const [kind, setKind] = useState<Kind>(existingAction?.kind ?? "key");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [liveToml, setLiveToml] = useState<string | null>(tomlEcho);

  // Remap field
  const [remapKey, , remapCapturing, captureRemapKey] = useCaptureKey(
    existingAction?.kind === "key" ? existingAction.key : ""
  );

  // Tap-hold fields
  const [tapKey, , tapCapturing, captureTapKey] = useCaptureKey(
    existingAction?.kind === "taphold" ? existingAction.tap : ""
  );
  const [holdKey, , holdCapturing, captureHoldKey] = useCaptureKey(
    existingAction?.kind === "taphold" && !existingAction.hold.startsWith("layer:")
      ? existingAction.hold
      : ""
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

  // Layer toggle field
  const [toggleLayer, setToggleLayer] = useState(
    existingAction?.kind === "layer_toggle" ? existingAction.layer : ""
  );

  const layers = listLayers(model, activeProfile).filter((l) => l !== "base");

  // Build the ActionModel from current field state
  const buildAction = useCallback((): ActionModel | null => {
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
        if (!isNaN(ms) && ms > 0) return { ...action, timeoutMs: ms };
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
  }, [kind, remapKey, tapKey, holdKey, holdIsLayer, holdLayerName, timeoutMs, toggleLayer]);

  // Sync kind on key change (component is remounted via `key` prop, so this
  // mainly handles programmatic layer/profile switches without remount)
  useEffect(() => {
    const a = getAction(model, activeProfile, activeLayer, keyName);
    setKind(a?.kind ?? "key");
    setSaveError(null);
    setLiveToml(tomlEcho);
  }, [keyName, activeProfile, activeLayer, tomlEcho]);

  // Rebuild live TOML echo whenever fields change
  useEffect(() => {
    const action = buildAction();
    if (action) {
      setLiveToml(actionToTomlLine(activeProfile, activeLayer, keyName, action));
    } else {
      setLiveToml(null);
    }
  }, [buildAction, activeProfile, activeLayer, keyName]);

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
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="inspector"
      role="region"
      aria-label={`Inspector for ${keyName}`}
    >
      {/* Header: key chip + kind segment control */}
      <div className="inspector__head">
        <span className="inspector__key-chip">{keyName}</span>
        <div className="seg">
          {KIND_LABELS.map(({ id, label }) => (
            <button
              key={id}
              className={`seg__btn${kind === id ? " seg__btn--active" : ""}`}
              onClick={() => { setKind(id); setSaveError(null); }}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="modal__close"
          onClick={onClose}
          aria-label="Close inspector"
          style={{ marginLeft: "auto" }}
        >
          ×
        </button>
      </div>

      {/* Body: labeled mono fields */}
      <div className="inspector__body">
        {kind === "key" && (
          <div className="inspector__field">
            <label className="inspector__field-label">Key</label>
            <button
              className={`inspector__field-val${remapCapturing ? " inspector__field-val--capture" : ""}`}
              onClick={captureRemapKey}
              disabled={remapCapturing}
              style={{ textAlign: "left", minWidth: 120 }}
            >
              {remapCapturing ? "press a key…" : remapKey || "—"}
            </button>
          </div>
        )}

        {kind === "taphold" && (
          <>
            <div className="inspector__field">
              <label className="inspector__field-label">Tap</label>
              <button
                className={`inspector__field-val${tapCapturing ? " inspector__field-val--capture" : ""}`}
                onClick={captureTapKey}
                disabled={tapCapturing}
                style={{ textAlign: "left", minWidth: 100 }}
              >
                {tapCapturing ? "press a key…" : tapKey || "—"}
              </button>
            </div>

            <div className="inspector__field">
              <label className="inspector__field-label">Hold</label>
              {holdIsLayer ? (
                <select
                  className="inspector__field-select"
                  value={holdLayerName}
                  onChange={(e) => setHoldLayerName(e.target.value)}
                >
                  <option value="">— layer —</option>
                  {layers.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              ) : (
                <button
                  className={`inspector__field-val${holdCapturing ? " inspector__field-val--capture" : ""}`}
                  onClick={captureHoldKey}
                  disabled={holdCapturing}
                  style={{ textAlign: "left", minWidth: 100 }}
                >
                  {holdCapturing ? "press a key…" : holdKey || "—"}
                </button>
              )}
            </div>

            <div className="inspector__field">
              <label className="inspector__field-label">Hold→layer</label>
              <input
                type="checkbox"
                checked={holdIsLayer}
                onChange={(e) => setHoldIsLayer(e.target.checked)}
                style={{ accentColor: "var(--teal)", width: 14, height: 14, marginTop: 6 }}
              />
            </div>

            <div className="inspector__field">
              <label className="inspector__field-label">Timeout ms</label>
              <input
                type="number"
                className="inspector__field-val"
                placeholder="default"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
                min={1}
                style={{ width: 90 }}
              />
            </div>
          </>
        )}

        {kind === "layer_toggle" && (
          <div className="inspector__field">
            <label className="inspector__field-label">Layer</label>
            <select
              className="inspector__field-select"
              value={toggleLayer}
              onChange={(e) => setToggleLayer(e.target.value)}
            >
              <option value="">— select —</option>
              {layers.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
        )}

        {(kind === "disabled" || kind === "passthrough") && (
          <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
            {kind === "disabled"
              ? "Key will be swallowed (no output)."
              : "Key passes through unchanged."}
          </span>
        )}

        <button
          className="inspector__apply"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? "Saving…" : "Apply"}
        </button>
      </div>

      {saveError && (
        <div className="inspector__error" role="alert">{saveError}</div>
      )}

      {/* Footer: live TOML echo */}
      <div className="inspector__toml">
        {liveToml ?? (
          <span className="muted">fill fields above to preview TOML</span>
        )}
      </div>
    </div>
  );
}
