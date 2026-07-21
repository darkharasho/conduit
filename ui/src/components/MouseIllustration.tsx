import type { ConfigModel, DeviceIdent } from "../lib/config-model";
import { actionWithEverywhereFallback, getEffectiveAction } from "../lib/config-model";
import { actionLabel, keyDisplayName } from "../lib/action-labels";
import type { DeviceLayout, DevicePhoto } from "../lib/mouse-layouts";

/** Standard controls the picture knows how to place (top-down view). */
export const ILLO_KEYS = [
  "btn_left",
  "btn_right",
  "btn_middle",
  "mouse4",
  "mouse5",
] as const;

/**
 * Additional controls shown in the side-view picture (G502X and similar).
 * These use f13–f16 codes written by the one-time onboard fix; curated labels
 * from the layout prop supply the human names ("Top button", etc.).
 * Keep-in-sync with mouse-layouts.ts G502X_MOUSE f13–f16 entries.
 */
export const SIDE_ILLO_KEYS = [
  "btn_left",
  "btn_right",
  "btn_middle",
  "mouse4",
  "mouse5",
  "f13",
  "f14",
  "f15",
  "f16",
] as const;

/**
 * Marker centers in the 560×500 viewBox — top-down view.
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

/**
 * Marker centers for the side-view (right-profile) picture.
 *
 * Derived from SideMouseBody in DeviceArt.tsx using the same transform
 * scale(3.2) translate(55, 10). Formula: x = (x_art + 55) * 3.2, y = (y_art + 10) * 3.2.
 * Keep-in-sync with SideMouseBody path data in DeviceArt.tsx.
 *
 * f13–f16 are the G502X side buttons exposed after the one-time onboard fix.
 * Provisional labels: Top button / Front trigger / Thumb button / Rear trigger
 * (in index order); Task 8 live-verifies and corrects if the physical order differs.
 */
const SIDE_MARKER_POS: Record<string, { x: number; y: number }> = {
  btn_left:   { x: 272, y:  83 }, // top-left button area  (~SideBody x=30, y=16)
  btn_right:  { x: 381, y:  83 }, // top-right button area (~SideBody x=64, y=16)
  btn_middle: { x: 336, y: 115 }, // wheel ellipse center  (~SideBody x=50, y=26)
  mouse5:     { x: 234, y: 250 }, // forward side strip (upper) (~SideBody x=18, y=68)
  mouse4:     { x: 234, y: 282 }, // back side strip    (lower) (~SideBody x=18, y=78)
  f13:        { x: 266, y: 144 }, // Top button    (~SideBody x=28, y=35)
  f14:        { x: 278, y: 173 }, // Front trigger (~SideBody x=32, y=44)
  f15:        { x: 246, y: 208 }, // Thumb button  (~SideBody x=22, y=55)
  f16:        { x: 266, y: 314 }, // Rear trigger  (~SideBody x=28, y=88) — kept clear of the mouse4/5 strip markers
};

interface Props {
  model: ConfigModel;
  activeProfile: string;
  activeLayer: string;
  selectedKey: string | null;
  onSelectKey: (keyName: string) => void;
  dev?: DeviceIdent | null;
  /** Standard controls present on this device (subset of ILLO_KEYS / SIDE_ILLO_KEYS). */
  keys: string[];
  /**
   * When true, draws the right-profile (side-view) body and shows side-button
   * markers including f13–f16. Pass alongside `layout` so human labels resolve.
   */
  sideView?: boolean;
  /**
   * Curated layout for this device; provides human-readable labels for f13–f16
   * ("Top button", "Front trigger", etc.) so aria-labels never show raw codes.
   * Keep-in-sync with mouse-layouts.ts G502X_MOUSE entry.
   */
  layout?: DeviceLayout | null;
  /**
   * Real product render to draw instead of the vector body. Marker positions
   * come from the photo's own marker table (natural pixel space, scaled into
   * the viewBox here), so photo layouts ignore MARKER_POS/SIDE_MARKER_POS.
   */
  photo?: DevicePhoto | null;
}

/**
 * Region of the 560×500 viewBox a photo may occupy. The photo centers in the
 * full box; the selection callout overlays it (solid tag background in photo
 * mode) instead of reserving an empty left strip.
 */
const PHOTO_REGION = { x: 24, y: 8, w: 528, h: 484 };

/** Fit a photo into PHOTO_REGION (contain, centered); returns placement + scale. */
function photoPlacement(photo: DevicePhoto) {
  const scale = Math.min(PHOTO_REGION.w / photo.width, PHOTO_REGION.h / photo.height);
  const w = photo.width * scale;
  const h = photo.height * scale;
  const x = PHOTO_REGION.x + (PHOTO_REGION.w - w) / 2;
  const y = PHOTO_REGION.y + (PHOTO_REGION.h - h) / 2;
  return { x, y, w, h, scale };
}

/** Look up the curated human label for a key from the layout, or fall back to keyDisplayName. */
function labelForKey(key: string, layout: DeviceLayout | null | undefined): string {
  if (layout) {
    for (const group of layout.groups) {
      for (const btn of group.buttons) {
        if (btn.key === key) return btn.label;
      }
    }
  }
  return keyDisplayName(key);
}

/**
 * Top-view mouse picture with a clickable marker on each standard control.
 * The selected control speaks: a callout names it and states its current
 * job in plain language. Everything else stays quiet — chips below the
 * picture cover wheel/extra controls the picture can't place.
 *
 * When sideView=true, draws the right-profile body and adds markers for
 * f13–f16 (G502X side buttons after the one-time onboard fix).
 */
export function MouseIllustration({
  model,
  activeProfile,
  activeLayer,
  selectedKey,
  onSelectKey,
  dev = null,
  keys,
  sideView = false,
  layout = null,
  photo = null,
}: Props) {
  const placement = photo ? photoPlacement(photo) : null;
  const markerPos: Record<string, { x: number; y: number }> =
    photo && placement
      ? Object.fromEntries(
          Object.entries(photo.markers).map(([k, p]) => [
            k,
            {
              x: placement.x + p.x * placement.scale,
              y: placement.y + p.y * placement.scale,
            },
          ]),
        )
      : sideView
        ? SIDE_MARKER_POS
        : MARKER_POS;
  const candidateKeys: readonly string[] = photo
    ? Object.keys(photo.markers)
    : sideView
      ? SIDE_ILLO_KEYS
      : ILLO_KEYS;
  const shown = candidateKeys.filter(
    (k) => keys.includes(k) && k in markerPos,
  );
  const overlayMode = activeProfile !== "default";

  const selected =
    selectedKey && shown.includes(selectedKey) ? selectedKey : null;
  const selectedPos = selected ? markerPos[selected] : null;
  const selectedEff = selected
    ? actionWithEverywhereFallback(model, activeProfile, dev, activeLayer, selected)
    : null;

  // Callout sits left of the mouse, vertically centered on its marker.
  const tagY = selectedPos ? Math.min(Math.max(selectedPos.y - 21, 44), 414) : 0;

  return (
    <svg
      className={photo ? "illo illo--photo" : "illo"}
      viewBox="0 0 560 500"
      role="group"
      aria-label="Mouse picture — click a button to change what it does"
    >
      {photo && placement ? (
        <image
          className="illo__photo"
          href={photo.src}
          x={placement.x}
          y={placement.y}
          width={placement.w}
          height={placement.h}
        />
      ) : sideView ? (
        /*
          Side-view (right-profile) static art — SideMouseBody from DeviceArt.tsx,
          scaled to fill the 560×500 viewBox using the same transform as top-down.
          Path data MUST stay visually in sync with DeviceArt.tsx (SideMouseBody).
          Transform: scale(3.2) translate(55, 10).
        */
        <g transform="scale(3.2) translate(55, 10)">
          {/* SideMouseBody — main body silhouette */}
          <path
            className="illo__body"
            d="M12 92 C 10 70 14 50 18 36 C 22 20 30 10 42 6 C 56 2 70 6 78 16 C 84 24 84 36 80 52 C 76 66 72 74 72 86 C 72 100 70 112 62 120 C 54 128 40 130 28 126 C 18 122 14 110 12 92 Z"
          />
          {/* SideMouseBody — top-edge left/right button seam */}
          <path className="illo__seam" d="M42 6 C 42 6 44 22 44 28" />
          {/* SideMouseBody — horizontal seam separating buttons from body */}
          <path className="illo__seam" d="M20 38 C 32 44 44 46 56 44 C 66 42 74 38 80 34" />
          {/* SideMouseBody — foreshortened wheel ellipse */}
          <ellipse className="illo__wheel" cx="50" cy="26" rx="5" ry="10" />
          {/* gaming-mouse 2-strip side buttons (lower-left of profile) */}
          {keys.includes("mouse5") && (
            <path className="illo__side" d="M14 68 L 22 66 L 23 74 L 15 76 Z" />
          )}
          {keys.includes("mouse4") && (
            <path className="illo__side" d="M15 78 L 23 76 L 24 84 L 16 86 Z" />
          )}
          {/* RGB accent arcs */}
          <path className="illo__accent" d="M26 114 L 42 108 L 58 114" />
          <path className="illo__accent illo__accent--dim" d="M30 120 L 44 114 L 58 120" />
        </g>
      ) : (
        /*
          Static art — gaming-mouse archetype from DeviceArt.tsx, scaled up to fill
          the 560×500 viewBox. Path data MUST stay visually in sync with DeviceArt.tsx
          (MouseBody + gaming-mouse children). Transform chosen so the body matches
          the old 560×500 footprint: top≈44, bottom≈448, left≈227, right≈435.
        */
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
      )}

      {shown.map((key) => {
        const pos = markerPos[key];
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
        const humanLabel = labelForKey(key, layout);
        return (
          <g
            key={key}
            data-illo-key={key}
            data-key={key}
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
            aria-label={`${humanLabel} — ${actionLabel(eff?.action ?? null)}`}
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
            {labelForKey(selected, layout)}
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
