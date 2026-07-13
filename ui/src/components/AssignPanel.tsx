import { useState } from "react";
import type { ActionModel, ConfigModel } from "../lib/config-model";
import { actionLabel, keyDisplayName, QUICK_PICKS } from "../lib/action-labels";
import { captureNextKey } from "../lib/client";
import { InspectorPanel } from "./InspectorPanel";

interface Props {
  keyName: string;
  model: ConfigModel;
  activeProfile: string;
  activeLayer: string;
  /** Effective current action (device override or profile); null = unmapped */
  currentAction: ActionModel | null;
  /** TOML echo passed through to the advanced editor */
  tomlEcho: string | null;
  onSave: (action: ActionModel) => Promise<void>;
  /** "Use default": remove the mapping so the button does its normal job */
  onUseDefault: () => Promise<void>;
  onClose: () => void;
}

/**
 * Plain-language assignment panel: press-to-set is the primary path, quick
 * picks cover the common one-click actions, and the old kind-based editor
 * stays available behind "Advanced options" for tap-hold and layers.
 */
export function AssignPanel({
  keyName,
  model,
  activeProfile,
  activeLayer,
  currentAction,
  tomlEcho,
  onSave,
  onUseDefault,
  onClose,
}: Props) {
  const [capturing, setCapturing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleCapture = () =>
    run(async () => {
      setCapturing(true);
      try {
        const captured = await captureNextKey();
        await onSave({ kind: "key", key: captured.name });
      } finally {
        setCapturing(false);
      }
    });

  if (advanced) {
    return (
      <div className="assign" role="region" aria-label={`Assign ${keyDisplayName(keyName)}`}>
        <button className="assign__back" onClick={() => setAdvanced(false)}>
          ‹ Back to simple options
        </button>
        <InspectorPanel
          keyName={keyName}
          model={model}
          activeProfile={activeProfile}
          activeLayer={activeLayer}
          tomlEcho={tomlEcho}
          onSave={onSave}
          onClose={onClose}
        />
      </div>
    );
  }

  return (
    <div className="assign" role="region" aria-label={`Assign ${keyDisplayName(keyName)}`}>
      <div className="assign__head">
        <div>
          <h2 className="assign__title">{keyDisplayName(keyName)}</h2>
          <p className="assign__now">
            Now: <span className="assign__now-val">{actionLabel(currentAction)}</span>
          </p>
        </div>
        <button className="modal__close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <button
        className={`assign__capture${capturing ? " assign__capture--live" : ""}`}
        onClick={handleCapture}
        disabled={capturing || busy}
      >
        <span className="assign__capture-key">
          <span className="assign__capture-dot" aria-hidden="true" />
          {capturing ? "Press any key…" : "Press to set"}
        </span>
        <span className="assign__capture-sub">
          {capturing
            ? "waiting for the key this button should type"
            : "Click, then press the key this button should type"}
        </span>
      </button>

      <div className="assign__or">or pick an action</div>

      <div className="assign__quick">
        {QUICK_PICKS.map((pick) => (
          <button
            key={pick.key}
            className="assign__pick"
            disabled={busy}
            onClick={() => run(() => onSave({ kind: "key", key: pick.key }))}
          >
            {pick.label}
            {pick.hint && <small>{pick.hint}</small>}
          </button>
        ))}
      </div>

      <button className="assign__advanced" onClick={() => setAdvanced(true)}>
        Advanced options… <small>tap-hold, layers</small>
      </button>

      {error && (
        <div className="inspector__error" role="alert">
          {error}
        </div>
      )}

      <div className="assign__foot">
        <button
          className="assign__default"
          disabled={busy}
          onClick={() => run(onUseDefault)}
        >
          Use default
        </button>
        <button
          className="assign__disable"
          disabled={busy}
          onClick={() => run(() => onSave({ kind: "disabled" }))}
        >
          Disable button
        </button>
      </div>
    </div>
  );
}
