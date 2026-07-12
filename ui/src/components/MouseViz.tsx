import type { ConfigModel, DeviceIdent } from "../lib/config-model";
import { getEffectiveAction } from "../lib/config-model";
import { actionHint } from "./KeyboardViz";

interface Props {
  model: ConfigModel;
  activeProfile: string;
  activeLayer: string;
  selectedKey: string | null;
  onSelectKey: (keyName: string) => void;
  /** Device tab context; null = no device (profile tables only). */
  dev?: DeviceIdent | null;
}

const WHEEL_KEYS = ["wheelup", "wheeldown", "wheelleft", "wheelright"] as const;
const EXTRA_KEYS = ["btn_forward", "btn_back", "btn_task"] as const;

/**
 * Mouse visualization for mouse/touchpad device tabs: a diagram for the
 * primary buttons and side buttons, plus chip groups for wheel directions
 * and the extra HID buttons. Mirrors KeyboardViz's selection contract.
 */
export function MouseViz({
  model,
  activeProfile,
  activeLayer,
  selectedKey,
  onSelectKey,
  dev = null,
}: Props) {
  const control = (key: string, label: string, extraClass = "") => {
    const eff = getEffectiveAction(model, activeProfile, dev, activeLayer, key);
    const hint = actionHint(eff?.action ?? null);
    const isSelected = key === selectedKey;
    return (
      <button
        key={key}
        data-key={key}
        className={[
          "mousekey",
          extraClass,
          eff ? "mousekey--mapped" : "",
          eff?.source === "device" ? "mousekey--devspec" : "",
          isSelected ? "mousekey--sel" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onClick={() => onSelectKey(key)}
        title={key}
        aria-label={`${label}${hint ? ` — ${hint}` : ""}`}
        aria-pressed={isSelected}
      >
        <span className="mousekey__label">{label}</span>
        {hint && <i className="mousekey__action">{hint}</i>}
      </button>
    );
  };

  return (
    <div className="mouse-viz" aria-label="Mouse layout">
      <div className="mouse-viz__body">
        {control("btn_left", "M1", "mousekey--m1")}
        {control("btn_middle", "M3", "mousekey--m3")}
        {control("btn_right", "M2", "mousekey--m2")}
        <div className="mouse-viz__side">
          {control("mouse4", "M4", "mousekey--side")}
          {control("mouse5", "M5", "mousekey--side")}
        </div>
      </div>
      <div className="mouse-viz__groups">
        <div>
          <div className="mouse-viz__group-label">Wheel</div>
          <div className="mouse-viz__chips">
            {WHEEL_KEYS.map((k) => control(k, k.replace("wheel", "wheel ")))}
          </div>
        </div>
        <div>
          <div className="mouse-viz__group-label">Extra buttons</div>
          <div className="mouse-viz__chips">
            {EXTRA_KEYS.map((k) => control(k, k.replace("btn_", "")))}
          </div>
        </div>
      </div>
    </div>
  );
}
