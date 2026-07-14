import type { ConfigModel, DeviceIdent } from "../lib/config-model";
import { getEffectiveAction } from "../lib/config-model";
import { actionLabel, keyDisplayName } from "../lib/action-labels";

/** Standard controls the picture knows how to place. */
export const ILLO_KEYS = [
  "btn_left",
  "btn_right",
  "btn_middle",
  "mouse4",
  "mouse5",
] as const;

/** Marker centers in the 560×500 viewBox. */
const MARKER_POS: Record<string, { x: number; y: number }> = {
  btn_left: { x: 280, y: 104 },
  btn_right: { x: 380, y: 104 },
  btn_middle: { x: 330, y: 170 },
  mouse5: { x: 211, y: 219 }, // front side button (forward)
  mouse4: { x: 215, y: 272 }, // rear side button (back)
};

interface Props {
  model: ConfigModel;
  activeProfile: string;
  activeLayer: string;
  selectedKey: string | null;
  onSelectKey: (keyName: string) => void;
  dev?: DeviceIdent | null;
  /** Standard controls present on this device (subset of ILLO_KEYS). */
  keys: string[];
}

/**
 * Top-view mouse picture with a clickable marker on each standard control.
 * The selected control speaks: a callout names it and states its current
 * job in plain language. Everything else stays quiet — chips below the
 * picture cover wheel/extra controls the picture can't place.
 */
export function MouseIllustration({
  model,
  activeProfile,
  activeLayer,
  selectedKey,
  onSelectKey,
  dev = null,
  keys,
}: Props) {
  const shown = ILLO_KEYS.filter((k) => keys.includes(k));

  const selected = selectedKey && shown.includes(selectedKey as (typeof ILLO_KEYS)[number])
    ? selectedKey
    : null;
  const selectedPos = selected ? MARKER_POS[selected] : null;
  const selectedEff = selected
    ? getEffectiveAction(model, activeProfile, dev, activeLayer, selected)
    : null;

  // Callout sits left of the mouse, vertically centered on its marker.
  const tagY = selectedPos ? Math.min(Math.max(selectedPos.y - 21, 44), 414) : 0;

  return (
    <svg
      className="illo"
      viewBox="0 0 560 500"
      role="group"
      aria-label="Mouse picture — click a button to change what it does"
    >
      {/* body */}
      <path
        className="illo__body"
        d="M330,44 C402,44 442,116 442,236 C442,356 402,448 330,448 C258,448 218,356 218,236 C218,116 258,44 330,44 Z"
      />
      {/* seams */}
      <path className="illo__seam" d="M330,44 L330,150" />
      <path className="illo__seam" d="M221,206 Q330,246 439,206" />
      {/* wheel */}
      <rect className="illo__wheel" x="317" y="92" width="26" height="54" rx="13" />
      <line className="illo__wheel-ridge" x1="330" y1="104" x2="330" y2="134" />
      {/* side buttons */}
      {keys.includes("mouse5") && (
        <rect className="illo__side" x="202" y="194" width="18" height="50" rx="9" />
      )}
      {keys.includes("mouse4") && (
        <rect className="illo__side" x="206" y="250" width="17" height="44" rx="8.5" />
      )}

      {shown.map((key) => {
        const pos = MARKER_POS[key];
        const eff = getEffectiveAction(model, activeProfile, dev, activeLayer, key);
        const action = eff?.action ?? null;
        const isSel = key === selected;
        const rawLabel = actionLabel(action);
        const jobLabel = rawLabel.length > 14 ? rawLabel.slice(0, 13) + "…" : rawLabel;
        return (
          <g
            key={key}
            data-illo-key={key}
            className={[
              "illo__marker",
              eff ? "illo__marker--mapped" : "",
              eff?.source === "device" ? "illo__marker--devspec" : "",
              isSel ? "illo__marker--sel" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            role="button"
            tabIndex={0}
            aria-label={`${keyDisplayName(key)} — ${actionLabel(eff?.action ?? null)}`}
            aria-pressed={isSel}
            onClick={() => onSelectKey(key)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") onSelectKey(key);
            }}
          >
            <circle className="illo__ring" cx={pos.x} cy={pos.y} r={isSel ? 13 : 11} />
            <circle className="illo__dot" cx={pos.x} cy={pos.y} r={isSel ? 4 : 3.5} />
            {action && (
              <text
                className="illo__joblabel"
                x={pos.x + 26}
                y={pos.y + 4}
              >
                {jobLabel}
              </text>
            )}
          </g>
        );
      })}

      {selected && selectedPos && (
        <g className="illo__callout" aria-hidden="true">
          <line
            className="illo__callout-line"
            x1={selectedPos.x - 14}
            y1={selectedPos.y}
            x2={162}
            y2={tagY + 21}
          />
          <rect className="illo__tag" x={8} y={tagY} width={152} height={42} rx={4} />
          <text className="illo__tag-title" x={18} y={tagY + 17}>
            {keyDisplayName(selected)}
          </text>
          <text className="illo__tag-sub" x={18} y={tagY + 33}>
            {actionLabel(selectedEff?.action ?? null)}
          </text>
        </g>
      )}
    </svg>
  );
}
