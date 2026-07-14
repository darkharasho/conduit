import type { Archetype } from "../lib/device-registry";

interface Props {
  archetype: Archetype;
  width?: number;
}

/** Mouse body outline shared by the three mouse archetypes. */
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

export function DeviceArt({ archetype, width = 96 }: Props) {
  const mouseView = "0 0 96 134";
  const kbView = "0 0 120 60";
  const isMouse = archetype !== "keyboard";
  return (
    <svg
      role="img"
      aria-label={archetype}
      width={width}
      viewBox={isMouse ? mouseView : kbView}
      className="device-art"
    >
      {archetype === "gaming-mouse" && (
        <MouseBody>
          <path d="M19 50 L 26 48 L 27 56 L 20 58 Z" fill="var(--bg-body)" stroke="var(--accent)" strokeWidth="1" />
          <path d="M20 61 L 27 59 L 28 67 L 21 69 Z" fill="var(--bg-body)" stroke="var(--accent)" strokeWidth="1" opacity=".7" />
          <path d="M32 104 L 48 96 L 64 104" stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".8" />
          <path d="M35 112 L 48 105 L 61 112" stroke="var(--accent)" strokeWidth="2" fill="none" strokeLinecap="round" opacity=".4" />
        </MouseBody>
      )}
      {archetype === "mmo-mouse" && (
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
