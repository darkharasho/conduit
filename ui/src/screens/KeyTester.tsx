import { useEffect, useRef, useState, useCallback } from "react";
import { onStatus, onKeyEvent } from "../lib/client";
import type { Status } from "../lib/client";
import { reduceEvents } from "../lib/event-pairing";
import type { TesterRow } from "../lib/event-pairing";

// ---- Sub-components ----

interface KeyChipProps {
  name: string;
  state: string;
}

function KeyChip({ name, state }: KeyChipProps) {
  const mod =
    state === "press"
      ? "key-chip--press"
      : state === "release"
      ? "key-chip--release"
      : "key-chip--repeat";
  return <span className={`key-chip ${mod}`}>{name}</span>;
}

interface ResolutionBadgeProps {
  text: string;
}

function ResolutionBadge({ text }: ResolutionBadgeProps) {
  const isSwallowed = text === "(swallowed)";
  return (
    <span
      className={`resolution-badge ${
        isSwallowed ? "resolution-badge--swallowed" : ""
      }`}
    >
      {text}
    </span>
  );
}

interface RowItemProps {
  row: TesterRow;
}

function RowItem({ row }: RowItemProps) {
  return (
    <div className="tester-row">
      {/* You pressed column */}
      <div className="tester-col tester-col--pre">
        <KeyChip name={row.pre.name} state={row.pre.state} />
        {row.repeats !== undefined && row.repeats > 0 && (
          <span className="repeat-count">×{row.repeats + 1}</span>
        )}
      </div>

      {/* Apps received column */}
      <div className="tester-col tester-col--post">
        {row.post.length > 0 ? (
          row.post
            .filter((p) => p.state === "press")
            .map((p, i) => <KeyChip key={i} name={p.name} state={p.state} />)
        ) : row._open ? (
          <span className="muted tester-pending">…</span>
        ) : (
          <span className="muted">—</span>
        )}
        {row.resolution !== undefined && (
          <ResolutionBadge text={row.resolution} />
        )}
      </div>
    </div>
  );
}

// ---- Main screen ----

export function KeyTesterScreen() {
  const [rows, setRows] = useState<TesterRow[]>([]);
  const [profile, setProfile] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hoverRef = useRef(false);

  // Subscribe to status for active profile display
  useEffect(() => {
    const unlistenP = onStatus((s: Status) => {
      setProfile(s.active_profile);
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, []);

  // Subscribe to key events, feed into reduceEvents via functional setState
  useEffect(() => {
    const unlistenP = onKeyEvent((ev) => {
      setRows((prev) => reduceEvents(prev, ev));
    });
    return () => {
      unlistenP.then((fn) => fn());
    };
  }, []);

  // Auto-scroll to top when rows change, unless pointer is hovering
  useEffect(() => {
    if (!hoverRef.current && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [rows]);

  const handleClear = useCallback(() => {
    setRows([]);
  }, []);

  // Reverse for newest-on-top display
  const displayRows = [...rows].reverse();

  return (
    <div className="screen key-tester-screen">
      {/* Header */}
      <div className="tester-header">
        <div className="tester-header__left">
          <h2 className="screen__title">Key Tester</h2>
          {profile !== null && (
            <span className="tester-profile-badge">{profile}</span>
          )}
        </div>
        <div className="tester-header__right">
          <span className="tester-hint muted">Hover list to pause scroll</span>
          <button
            className="btn btn--secondary tester-clear-btn"
            onClick={handleClear}
            aria-label="Clear key tester history"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Column headers */}
      <div className="tester-cols-header">
        <div className="tester-col-label">You pressed</div>
        <div className="tester-col-label">Apps received</div>
      </div>

      {/* Event list */}
      <div
        ref={listRef}
        className="tester-list"
        onMouseEnter={() => {
          hoverRef.current = true;
        }}
        onMouseLeave={() => {
          hoverRef.current = false;
        }}
        role="log"
        aria-label="Key event log"
        aria-live="polite"
      >
        {displayRows.length === 0 ? (
          <div className="tester-empty muted">
            Press any key to start recording…
          </div>
        ) : (
          displayRows.map((row) => <RowItem key={row.id} row={row} />)
        )}
      </div>
    </div>
  );
}
