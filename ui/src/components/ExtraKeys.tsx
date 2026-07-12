import { useState } from "react";
import type { ConfigModel, DeviceIdent } from "../lib/config-model";
import { getEffectiveAction } from "../lib/config-model";
import { keyNameForCode } from "../lib/keyboard-layout";
import { actionHint } from "./KeyboardViz";

interface Props {
  model: ConfigModel;
  activeProfile: string;
  activeLayer: string;
  selectedKey: string | null;
  onSelectKey: (keyName: string) => void;
  dev: DeviceIdent | null;
  /** Device-declared EV_KEY codes NOT already shown by the main viz. */
  codes: number[];
}

const COLLAPSED_COUNT = 24;

/**
 * Chip strip for device-declared keys that the main visualization doesn't
 * show (media keys, gaming G-button codes, etc.). Every chip is mappable —
 * unknown codes use the daemon's `key:N` fallback name.
 */
export function ExtraKeys({
  model,
  activeProfile,
  activeLayer,
  selectedKey,
  onSelectKey,
  dev,
  codes,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  if (codes.length === 0) return null;
  const visible = expanded ? codes : codes.slice(0, COLLAPSED_COUNT);
  const hidden = codes.length - visible.length;

  return (
    <div className="extra-keys">
      <div className="mouse-viz__group-label">
        Also on this device ({codes.length})
      </div>
      <div className="mouse-viz__chips extra-keys__chips">
        {visible.map((code) => {
          const key = keyNameForCode(code);
          const eff = getEffectiveAction(model, activeProfile, dev, activeLayer, key);
          const hint = actionHint(eff?.action ?? null);
          const isSelected = key === selectedKey;
          return (
            <button
              key={code}
              data-key={key}
              className={[
                "mousekey",
                eff ? "mousekey--mapped" : "",
                eff?.source === "device" ? "mousekey--devspec" : "",
                isSelected ? "mousekey--sel" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onSelectKey(key)}
              title={key}
              aria-pressed={isSelected}
            >
              <span className="mousekey__label">{key}</span>
              {hint && <i className="mousekey__action">{hint}</i>}
            </button>
          );
        })}
        {hidden > 0 && (
          <button className="btn extra-keys__more" onClick={() => setExpanded(true)}>
            +{hidden} more
          </button>
        )}
        {expanded && codes.length > COLLAPSED_COUNT && (
          <button className="btn extra-keys__more" onClick={() => setExpanded(false)}>
            collapse
          </button>
        )}
      </div>
    </div>
  );
}
