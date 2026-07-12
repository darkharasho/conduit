import type { ConfigModel, ActionModel, DeviceIdent } from "../lib/config-model";
import { getEffectiveAction } from "../lib/config-model";
import { ANSI_LAYOUT, codeForKeyName, keyNameForCode } from "../lib/keyboard-layout";
import { ExtraKeys } from "./ExtraKeys";

interface Props {
  model: ConfigModel;
  activeProfile: string;
  activeLayer: string;
  selectedKey: string | null;
  onSelectKey: (keyName: string) => void;
  /** Device tab context; null = no device (profile tables only). */
  dev?: DeviceIdent | null;
}

/**
 * Short mono action hint for the key cap second line.
 * Matches mockup examples: `esc⁄ctrl`, `hold:shift`, `hold:nav`, `L:nav`, `∅`
 */
export function actionHint(action: ActionModel | null): string {
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

export function KeyboardViz({
  model,
  activeProfile,
  activeLayer,
  selectedKey,
  onSelectKey,
  dev = null,
}: Props) {
  const COLS_PER_U = 4;

  // Capability filtering: when the device reports its key codes, dim board
  // keys it doesn't declare and list declared codes the board doesn't show.
  const declared = dev?.keys && dev.keys.length > 0 ? new Set(dev.keys) : null;
  const boardCodes = new Set(
    ANSI_LAYOUT.flat()
      .map((cap) => codeForKeyName(cap.name))
      .filter((c): c is number => c !== null)
  );
  const extraCodes = declared
    ? [...declared].filter((c) => !boardCodes.has(c)).sort((a, b) => a - b)
    : [];

  return (
    <div className="keyboard-wrap" aria-label="Keyboard layout">
      {ANSI_LAYOUT.map((row, rowIdx) => {
        let colStart = 1;
        return (
          <div
            key={rowIdx}
            className="keyboard-wrap__row"
            style={{ gridTemplateColumns: `repeat(60, 1fr)`, gap: "3px" }}
          >
            {row.map((cap) => {
              const span = Math.round(cap.width * COLS_PER_U);
              const start = colStart;
              colStart += span;

              const eff = getEffectiveAction(model, activeProfile, dev, activeLayer, cap.name);
              const hint = actionHint(eff?.action ?? null);
              const isSelected = cap.name === selectedKey;
              const code = codeForKeyName(cap.name);
              const absent = declared !== null && code !== null && !declared.has(code);

              return (
                <button
                  key={cap.name}
                  className={[
                    "keycap",
                    eff ? "keycap--mapped" : "",
                    eff?.source === "device" ? "keycap--devspec" : "",
                    isSelected ? "keycap--selected" : "",
                    absent ? "keycap--absent" : "",
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
      })}
      <ExtraKeys
        model={model}
        activeProfile={activeProfile}
        activeLayer={activeLayer}
        selectedKey={selectedKey}
        onSelectKey={onSelectKey}
        dev={dev}
        codes={extraCodes}
        // Named codes (media keys etc.) are plausibly real; bare key:N codes
        // on a keyboard node are usually descriptor filler.
        primary={(c) => !keyNameForCode(c).startsWith("key:")}
      />
    </div>
  );
}
