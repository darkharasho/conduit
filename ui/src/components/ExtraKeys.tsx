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
  /**
   * Split predicate: `true` = plausibly a real control (shown up front),
   * `false` = declared by the HID descriptor but almost certainly not a
   * physical control (gaming firmware declares the whole range "just in
   * case") — hidden behind an explicit expander.
   */
  primary: (code: number) => boolean;
}

/**
 * Chip strip for device-declared keys that the main visualization doesn't
 * show. Every chip is mappable — unknown codes use the daemon's `key:N`
 * fallback name. Use the Detect flow (Mappings toolbar) to find which
 * declared code a physical button actually emits.
 */
export function ExtraKeys({
  model,
  activeProfile,
  activeLayer,
  selectedKey,
  onSelectKey,
  dev,
  codes,
  primary,
}: Props) {
  const [expanded, setExpanded] = useState(false);

  if (codes.length === 0) return null;
  const primaryCodes = codes.filter(primary);
  const secondaryCodes = codes.filter((c) => !primary(c));

  const chip = (code: number) => {
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
  };

  return (
    <div className="extra-keys">
      {primaryCodes.length > 0 && (
        <>
          <div className="mouse-viz__group-label">
            Also on this device ({primaryCodes.length})
          </div>
          <div className="mouse-viz__chips extra-keys__chips">
            {primaryCodes.map(chip)}
          </div>
        </>
      )}
      {secondaryCodes.length > 0 && (
        <div className="extra-keys__declared">
          <button
            className="btn extra-keys__more"
            onClick={() => setExpanded((v) => !v)}
            title="HID descriptors often declare far more codes than the device has physical controls. Use Detect to find what a button really emits."
          >
            {expanded ? "hide" : "show"} {secondaryCodes.length} more declared codes
            (likely unused — firmware over-declares)
          </button>
          {expanded && (
            <div className="mouse-viz__chips extra-keys__chips" style={{ marginTop: 6 }}>
              {secondaryCodes.map(chip)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
