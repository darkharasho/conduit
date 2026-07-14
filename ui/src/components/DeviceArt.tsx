import type { Archetype } from "../lib/device-registry";

interface Props {
  archetype: Archetype;
  width?: number;
  /**
   * When true and archetype is gaming-mouse or mmo-mouse, draw the right-
   * profile (side-view) body instead of the default top-down view.
   * Keep-in-sync with MouseIllustration.tsx side-view path data and MARKER_POS.
   */
  sideView?: boolean;
}

/** Mouse body outline shared by the three mouse archetypes (top-down view). */
function MouseBody({ children }: { children?: React.ReactNode }) {
  return (
    <>
      <path
        d="M48 4 C 66 4 78 15 81 32 C 83 44 79 52 80 62 C 82 82 84 100 74 115 C 67 126 56 130 48 130 C 38 130 28 125 22 114 C 14 99 16 82 18 64 C 19 52 14 44 16 32 C 19 15 31 4 48 4 Z"
        fill="var(--bg-key)" stroke="var(--border-control)" strokeWidth="1.5"
      />
      <path d="M48 4 L 48 22" stroke="var(--bg-body)" strokeWidth="2" />
      <path d="M17 34 C 30 40 42 41 48 41 C 54 41 66 40 79 34" stroke="var(--bg-body)" strokeWidth="2" fill="none" />
      <rect x="42" y="16" width="12" height="24" rx="6" fill="var(--bg-body)" />
      <rect x="44" y="18" width="8" height="20" rx="4" fill="var(--bg-key)" stroke="var(--accent)" strokeWidth="1" />
      {children}
    </>
  );
}

/**
 * Right-profile (side-view) mouse body shared by gaming-mouse and mmo-mouse
 * when sideView=true.
 *
 * Keep-in-sync: the scaled variant of these paths lives in MouseIllustration.tsx
 * (side-view static art). If you change path geometry here, update those paths
 * and the SIDE_MARKER_POS table to match.
 *
 * ViewBox context: 96×134.
 * The body is a right-profile silhouette — rear (left) is tall, front (right)
 * slopes down. Thumb-rest bump sits in the lower-left. The left/right primary
 * button split appears as a crease along the top edge.
 */
function SideMouseBody({ children }: { children?: React.ReactNode }) {
  return (
    <>
      {/* Main body silhouette */}
      <path
        d="M12 92 C 10 70 14 50 18 36 C 22 20 30 10 42 6 C 56 2 70 6 78 16 C 84 24 84 36 80 52 C 76 66 72 74 72 86 C 72 100 70 112 62 120 C 54 128 40 130 28 126 C 18 122 14 110 12 92 Z"
        fill="var(--bg-key)" stroke="var(--border-control)" strokeWidth="1.5"
      />
      {/* Top-edge left/right button seam */}
      <path d="M42 6 C 42 6 44 22 44 28" stroke="var(--bg-body)" strokeWidth="1.5" fill="none" />
      {/* Horizontal seam separating buttons from body */}
      <path d="M20 38 C 32 44 44 46 56 44 C 66 42 74 38 80 34" stroke="var(--bg-body)" strokeWidth="1.5" fill="none" />
      {/* Foreshortened wheel (ellipse at top) */}
      <ellipse cx="50" cy="26" rx="5" ry="10" fill="var(--bg-body)" stroke="var(--accent)" strokeWidth="1" />
      {children}
    </>
  );
}

export function DeviceArt({ archetype, width = 96, sideView = false }: Props) {
  const mouseView = "0 0 96 134";
  const kbView = "0 0 120 60";
  const isMouse = archetype !== "keyboard";
  const showSideView = sideView && (archetype === "gaming-mouse" || archetype === "mmo-mouse");
  return (
    <svg
      aria-hidden="true"
      width={width}
      viewBox={isMouse ? mouseView : kbView}
      className="device-art"
    >
      {/* Side-view (right profile) variants for gaming-mouse and mmo-mouse */}
      {showSideView && archetype === "gaming-mouse" && (
        <g data-view="side">
          <SideMouseBody>
            {/* 2-strip side buttons on the lower-left of the profile body */}
            <path d="M14 68 L 22 66 L 23 74 L 15 76 Z" fill="var(--bg-body)" stroke="var(--accent)" strokeWidth="1" />
            <path d="M15 78 L 23 76 L 24 84 L 16 86 Z" fill="var(--bg-body)" stroke="var(--accent)" strokeWidth="1" opacity=".7" />
            {/* RGB accent arc at base */}
            <path d="M26 114 L 42 108 L 58 114" stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".8" />
            <path d="M30 120 L 44 114 L 58 120" stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".4" />
          </SideMouseBody>
        </g>
      )}
      {showSideView && archetype === "mmo-mouse" && (
        <g data-view="side">
          <SideMouseBody>
            {/* 4×3 thumb grid — MMO side view, left portion of profile */}
            {[0, 1, 2, 3].map((r) =>
              [0, 1, 2].map((c) => (
                <rect
                  key={`${r}-${c}`}
                  x={10 + c * 7} y={60 + r * 10}
                  width="6" height="8" rx="1.5"
                  fill="var(--bg-body)" stroke="var(--accent)" strokeWidth="0.8" opacity=".8"
                />
              )),
            )}
          </SideMouseBody>
        </g>
      )}
      {/* Default top-down view when sideView is false */}
      {!showSideView && archetype === "gaming-mouse" && (
        <MouseBody>
          <path d="M19 50 L 26 48 L 27 56 L 20 58 Z" fill="var(--bg-body)" stroke="var(--accent)" strokeWidth="1" />
          <path d="M20 61 L 27 59 L 28 67 L 21 69 Z" fill="var(--bg-body)" stroke="var(--accent)" strokeWidth="1" opacity=".7" />
          <path d="M32 104 L 48 96 L 64 104" stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".8" />
          <path d="M35 112 L 48 105 L 61 112" stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".4" />
        </MouseBody>
      )}
      {!showSideView && archetype === "mmo-mouse" && (
        <MouseBody>
          {/* 4×3 thumb grid — the MMO signature */}
          {[0, 1, 2, 3].map((r) =>
            [0, 1, 2].map((c) => (
              <rect
                key={`${r}-${c}`}
                x={14 + c * 7} y={48 + r * 10}
                width="6" height="8" rx="1.5"
                fill="var(--bg-body)" stroke="var(--accent)" strokeWidth="0.8" opacity=".8"
              />
            )),
          )}
        </MouseBody>
      )}
      {archetype === "mouse" && (
        <MouseBody>
          <path d="M20 52 L 27 50 L 28 58 L 21 60 Z" fill="var(--bg-body)" stroke="var(--border-control)" strokeWidth="1" />
        </MouseBody>
      )}
      {archetype === "keyboard" && (
        <>
          <rect x="2" y="8" width="116" height="44" rx="7" fill="var(--bg-key)" stroke="var(--border-control)" strokeWidth="1.5" />
          {[15, 26, 37].map((y, row) =>
            Array.from({ length: row === 2 ? 5 : 9 }, (_, i) => (
              <rect
                key={`${y}-${i}`}
                x={9 + i * (row === 2 ? 21 : 12)} y={y}
                width={row === 2 && i === 2 ? 40 : 9} height="8" rx="2"
                fill="var(--bg-body)" stroke="var(--border-control)" strokeWidth="0.7"
              />
            )),
          )}
          <path d="M9 54 L 111 54" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" opacity=".5" />
        </>
      )}
    </svg>
  );
}
