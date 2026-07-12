import type { ConfigModel, ActionModel } from "../lib/config-model";
import { getAction } from "../lib/config-model";
import { ANSI_LAYOUT } from "../lib/keyboard-layout";

interface Props {
  model: ConfigModel;
  activeProfile: string;
  activeLayer: string;
  selectedKey: string | null;
  onSelectKey: (keyName: string) => void;
}

/** Short human-readable summary of an action for the key cap label */
function actionSummary(action: ActionModel | null): string {
  if (!action) return "";
  switch (action.kind) {
    case "key":
      return `→${action.key}`;
    case "taphold": {
      const tapPart = action.tap.length <= 3 ? action.tap : action.tap.slice(0, 3);
      const holdPart = action.hold.startsWith("layer:")
        ? `L:${action.hold.slice(6)}`
        : action.hold.length <= 3
        ? action.hold
        : action.hold.slice(0, 3);
      return `${tapPart}/${holdPart}`;
    }
    case "layer_toggle":
      return `L:${action.layer}`;
    case "disabled":
      return "∅";
    case "passthrough":
      return "↑";
  }
}

export function KeyboardViz({
  model,
  activeProfile,
  activeLayer,
  selectedKey,
  onSelectKey,
}: Props) {
  // Grid uses 60 columns (each 1u = 4 cols, so 15u = 60 cols)
  // Mouse row is exempt — it uses the same 4-cols-per-u scheme but may not fill 60 cols
  const COLS_PER_U = 4;

  return (
    <div className="keyboard-viz" aria-label="Keyboard layout">
      {ANSI_LAYOUT.map((row, rowIdx) => {
        let colStart = 1;
        return (
          <div
            key={rowIdx}
            className="keyboard-viz__row"
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(60, 1fr)`,
              gap: "2px",
              marginBottom: "3px",
            }}
          >
            {row.map((cap) => {
              const span = Math.round(cap.width * COLS_PER_U);
              const start = colStart;
              colStart += span;

              const action = getAction(model, activeProfile, activeLayer, cap.name);
              const summary = actionSummary(action);
              const isMapped = action !== null;
              const isSelected = cap.name === selectedKey;

              return (
                <button
                  key={cap.name}
                  className={[
                    "keycap",
                    isMapped ? "keycap--mapped" : "",
                    isSelected ? "keycap--selected" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{
                    gridColumn: `${start} / span ${span}`,
                  }}
                  onClick={() => onSelectKey(cap.name)}
                  title={cap.name}
                  aria-label={`${cap.label}${summary ? ` — ${summary}` : ""}`}
                  aria-pressed={isSelected}
                >
                  <span className="keycap__label">{cap.label}</span>
                  {summary && (
                    <span className="keycap__action">{summary}</span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
