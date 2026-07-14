import type { ConfigModel, DeviceIdent } from "../lib/config-model";
import { actionWithEverywhereFallback, getEffectiveAction } from "../lib/config-model";
import { actionLabel, keyDisplayName } from "../lib/action-labels";

/** Standard controls the picture knows how to place. */
export const ILLO_KEYS = [
  "btn_left",
  "btn_right",
  "btn_middle",
  "mouse4",
  "mouse5",
] as const;

/**
 * Marker centers in the 560×500 viewBox.
 *
 * These coordinates are derived from the DeviceArt gaming-mouse geometry
 * (ui/src/components/DeviceArt.tsx) using the same transform applied to the
 * static art below: scale(3.2) translate(55, 10).
 * Formula: x_new = (x_devart + 55) * 3.2, y_new = (y_devart + 10) * 3.2
 * If DeviceArt paths change, update these markers to match.
 */
const MARKER_POS: Record<string, { x: number; y: number }> = {
  btn_left:   { x: 282, y:  96 }, // left of top split seam  (~DeviceArt x=33, y=20)
  btn_right:  { x: 378, y:  96 }, // right of top split seam (~DeviceArt x=63, y=20)
  btn_middle: { x: 330, y: 122 }, // wheel rect center        (~DeviceArt x=48, y=28)
  mouse5:     { x: 250, y: 202 }, // front side button (forward, upper) (~DeviceArt x=23, y=53)
  mouse4:     { x: 253, y: 237 }, // rear side button  (back,    lower) (~DeviceArt x=24, y=64)
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
  const overlayMode = activeProfile !== "default";

  const selected = selectedKey && shown.includes(selectedKey as (typeof ILLO_KEYS)[number])
    ? selectedKey
    : null;
  const selectedPos = selected ? MARKER_POS[selected] : null;
  const selectedEff = selected
    ? actionWithEverywhereFallback(model, activeProfile, dev, activeLayer, selected)
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
      {/*
        Static art — gaming-mouse archetype from DeviceArt.tsx, scaled up to fill
        the 560×500 viewBox. Path data MUST stay visually in sync with DeviceArt.tsx
        (MouseBody + gaming-mouse children). Transform chosen so the body matches
        the old 560×500 footprint: top≈44, bottom≈448, left≈227, right≈435.
      */}
      <g transform="scale(3.2) translate(55, 10)">
        {/* MouseBody — main body outline */}
        <path
          className="illo__body"
          d="M48 4 C 66 4 78 15 81 32 C 83 44 79 52 80 62 C 82 82 84 100 74 115 C 67 126 56 130 48 130 C 38 130 28 125 22 114 C 14 99 16 82 18 64 C 19 52 14 44 16 32 C 19 15 31 4 48 4 Z"
        />
        {/* MouseBody — top split seam */}
        <path className="illo__seam" d="M48 4 L 48 22" />
        {/* MouseBody — horizontal seam below buttons */}
        <path className="illo__seam" d="M17 34 C 30 40 42 41 48 41 C 54 41 66 40 79 34" />
        {/* MouseBody — scroll wheel */}
        <rect className="illo__wheel" x="44" y="18" width="8" height="20" rx="4" />
        {/* gaming-mouse side buttons (left thumb buttons) */}
        {keys.includes("mouse5") && (
          <path className="illo__side" d="M19 50 L 26 48 L 27 56 L 20 58 Z" />
        )}
        {keys.includes("mouse4") && (
          <path className="illo__side" d="M20 61 L 27 59 L 28 67 L 21 69 Z" />
        )}
        {/* gaming-mouse RGB accent arcs */}
        <path className="illo__accent" d="M32 104 L 48 96 L 64 104" />
        <path className="illo__accent illo__accent--dim" d="M35 112 L 48 105 L 61 112" />
      </g>

      {shown.map((key) => {
        const pos = MARKER_POS[key];
        const eff = actionWithEverywhereFallback(model, activeProfile, dev, activeLayer, key);
        const action = eff?.action ?? null;
        const isSel = key === selected;
        const rawLabel = actionLabel(action);
        const jobLabel = rawLabel.length > 14 ? rawLabel.slice(0, 13) + "…" : rawLabel;
        const isInherited = overlayMode && eff?.source === "everywhere";
        const isOverride = overlayMode && eff?.source === "app";
        // Preserve device-specific styling when not in overlay mode (default profile behavior)
        const rawEff = !overlayMode
          ? getEffectiveAction(model, activeProfile, dev, activeLayer, key)
          : null;
        const isDevSpec = !overlayMode && rawEff?.source === "device";
        return (
          <g
            key={key}
            data-illo-key={key}
            className={[
              "illo__marker",
              eff ? "illo__marker--mapped" : "",
              isDevSpec ? "illo__marker--devspec" : "",
              isInherited ? "illo__marker--inherited" : "",
              isOverride ? "illo__marker--override" : "",
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
                className={[
                  "illo__joblabel",
                  isInherited ? "illo__joblabel--inherited" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
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
          <rect
            className="illo__tag"
            x={8}
            y={tagY}
            width={152}
            height={overlayMode && selectedEff?.source === "everywhere" ? 54 : 42}
            rx={4}
          />
          <text className="illo__tag-title" x={18} y={tagY + 17}>
            {keyDisplayName(selected)}
          </text>
          <text className="illo__tag-sub" x={18} y={tagY + 33}>
            {actionLabel(selectedEff?.action ?? null)}
          </text>
          {overlayMode && selectedEff?.source === "everywhere" && (
            <text className="illo__tag-inherited" x={18} y={tagY + 47}>
              Same as Everywhere
            </text>
          )}
        </g>
      )}
    </svg>
  );
}
