import { useState } from "react";
import { listWindows } from "../lib/client";
import type { FocusInfo } from "../lib/client";
import type { ConfigModel } from "../lib/config-model";

interface Props {
  model: ConfigModel;
  profileName: string;
  /** Receives the cleaned match fields (empty values already stripped). */
  onApply: (match: Record<string, string>) => void;
}

const FIELDS = ["class", "process", "title"] as const;

/**
 * Per-profile match editor: links a profile to an application by window
 * class / process name / title regex, with a picker fed by the daemon's
 * ListWindows. Hidden for the default profile (it must not have a match).
 */
export function ProfileMatchEditor({ model, profileName, onApply }: Props) {
  const prof = model.profiles.find((p) => p.name === profileName);
  const [fields, setFields] = useState<Record<string, string>>(() => ({
    class: prof?.match?.["class"] ?? "",
    process: prof?.match?.["process"] ?? "",
    title: prof?.match?.["title"] ?? "",
  }));
  const [windows, setWindows] = useState<FocusInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!prof || profileName === "default") return null;

  const openPicker = async () => {
    setLoading(true);
    setError(null);
    try {
      setWindows(await listWindows());
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  const pick = (w: FocusInfo) => {
    setFields((f) => ({ ...f, class: w.class, process: w.process }));
    setWindows(null);
  };

  const apply = () => {
    const out: Record<string, string> = {};
    for (const k of FIELDS) {
      if (fields[k].trim() !== "") out[k] = fields[k].trim();
    }
    onApply(out);
  };

  return (
    <div className="inspector">
      <div className="inspector__field-label">
        Match — link “{profileName}” to an application
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        {FIELDS.map((k) => (
          <label key={k} className="inspector__field-label" style={{ flex: 1 }}>
            {k}
            <input
              aria-label={k}
              className="new-layer-input"
              style={{ width: "100%", marginTop: 4 }}
              type="text"
              value={fields[k]}
              placeholder={k === "title" ? "regex, e.g. .*YouTube.*" : ""}
              onChange={(e) => setFields((f) => ({ ...f, [k]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button className="btn btn--primary" onClick={apply}>
          Apply match
        </button>
        <button className="btn" onClick={openPicker}>
          Pick from open windows
        </button>
      </div>
      {loading && <div className="muted">Loading windows…</div>}
      {error && (
        <div className="banner--error" role="alert">
          {error}
        </div>
      )}
      {windows && windows.length === 0 && !loading && (
        <div className="muted">No windows found.</div>
      )}
      {windows && windows.length > 0 && (
        <ul className="window-list">
          {windows.map((w, i) => (
            <li key={i}>
              <button className="window-list__item" onClick={() => pick(w)}>
                <span className="window-list__class">{w.class}</span>
                <span className="window-list__title muted"> — {w.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
