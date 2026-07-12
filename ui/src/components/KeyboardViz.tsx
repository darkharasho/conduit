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

/**
 * Short mono action hint for the key cap second line.
 * Matches mockup examples: `esc⁄ctrl`, `hold:shift`, `hold:nav`, `L:nav`, `∅`
 */
function actionHint(action: ActionModel | null): string {
  if (!action) return "";
  switch (action.kind) {
    case "key":
      return action.key.length <= 6 ? action.key : action.key.slice(0, 6);
    case "taphold": {
      const tap = action.tap.length <= 3 ? action.tap : action.tap.slice(0, 3);
      const holdRaw = action.hold;
      const hold = holdRaw.startsWith("layer:")
        ? holdRaw.slice(6, 9)
        : holdRaw.length <= 4
        ? holdRaw
        : holdRaw.slice(0, 4);
      return `${tap}⁄${hold}`;
    }
    case "layer_toggle":
      return `L:${action.layer.slice(0, 4)}`;
    case "disabled":
      return "∅";
    case "passthrough":
      return "pass";
  }
}

/** The last keyboard row (index 6) is the mouse row */
const MOUSE_ROW_IDX = 6;

export function KeyboardViz({
  model,
  activeProfile,
  activeLayer,
  selectedKey,
  onSelectKey,
}: Props) {
  const COLS_PER_U = 4;

  // Split layout: keyboard rows vs mouse row
  const keyRows = ANSI_LAYOUT.slice(0, MOUSE_ROW_IDX);
  const mouseRow = ANSI_LAYOUT[MOUSE_ROW_IDX] ?? [];

  function renderRow(row: typeof ANSI_LAYOUT[0], rowIdx: number, isMouse = false) {
    let colStart = 1;
    return (
      <div
        key={rowIdx}
        className="keyboard-wrap__row"
        style={{
          gridTemplateColumns: `repeat(60, 1fr)`,
          gap: "3px",
          marginBottom: isMouse ? 0 : 0,
        }}
      >
        {row.map((cap) => {
          const span = Math.round(cap.width * COLS_PER_U);
          const start = colStart;
          colStart += span;

          const action = getAction(model, activeProfile, activeLayer, cap.name);
          const hint = actionHint(action);
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
              style={{ gridColumn: `${start} / span ${span}` }}
              onClick={() => onSelectKey(cap.name)}
              title={cap.name}
              aria-label={`${cap.label}${hint ? ` — ${hint}` : ""}`}
              aria-pressed={isSelected}
            >
              <span className="keycap__label">{cap.label}</span>
              {hint && <i className="keycap__action">{hint}</i>}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="keyboard-wrap" aria-label="Keyboard layout">
      {/* Main keyboard rows */}
      {keyRows.map((row, idx) => renderRow(row, idx))}

      {/* Mouse row at 38% width */}
      {mouseRow.length > 0 && (
        <div className="mouse-row">
          {mouseRow.map((cap) => {
            const action = getAction(model, activeProfile, activeLayer, cap.name);
            const hint = actionHint(action);
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
                onClick={() => onSelectKey(cap.name)}
                title={cap.name}
                aria-label={`${cap.label}${hint ? ` — ${hint}` : ""}`}
                aria-pressed={isSelected}
              >
                <span className="keycap__label">{cap.label}</span>
                {hint && <i className="keycap__action">{hint}</i>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
