import { useEffect, useRef, useState, useCallback } from "react";
import { onStatus, onKeyEvent } from "../lib/client";
import type { Status } from "../lib/client";
import { reduceEvents } from "../lib/event-pairing";
import type { TesterRow } from "../lib/event-pairing";
import { Toolbar } from "../components/Toolbar";

// ---- Sub-components ----

interface InKeyChipProps {
  name: string;
  state: string;
}

function InKeyChip({ name, state }: InKeyChipProps) {
  const mod =
    state === "press"
      ? "key-chip--press"
      : state === "release"
      ? "key-chip--release"
      : "key-chip--repeat";
  return <span className={`key-chip ${mod}`}>{name}</span>;
}

interface OutKeyChipProps {
  text: string;
}

function OutKeyChip({ text }: OutKeyChipProps) {
  const isSwallowed = text === "(swallowed)";
  return (
    <span className={isSwallowed ? "out-chip out-chip--swallowed" : "out-chip"}>
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
      <div className="tester-col">
        <InKeyChip name={row.pre.name} state={row.pre.state} />
        {row.repeats !== undefined && row.repeats > 0 && (
          <span className="repeat-count">×{row.repeats + 1}</span>
        )}
      </div>

      {/* Apps received column */}
      <div className="tester-col">
        {row.post.length > 0 ? (
          row.post
            .filter((p) => p.state === "press")
            .map((p, i) => <OutKeyChip key={i} text={p.name} />)
        ) : row._open ? (
          <span className="tester-pending">…</span>
        ) : row.resolution === undefined ? (
          <span className="muted">—</span>
        ) : null}
        {row.resolution !== undefined && (
          <OutKeyChip text={row.resolution} />
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

  useEffect(() => {
    const p = onStatus((s: Status) => setProfile(s.active_profile));
    return () => { p.then((f) => f()); };
  }, []);

  useEffect(() => {
    const p = onKeyEvent((ev) => {
      setRows((prev) => reduceEvents(prev, ev));
    });
    return () => { p.then((f) => f()); };
  }, []);

  useEffect(() => {
    if (!hoverRef.current && listRef.current) {
      listRef.current.scrollTop = 0;
    }
  }, [rows]);

  const handleClear = useCallback(() => setRows([]), []);

  const displayRows = [...rows].reverse();

  return (
    <div className="screen-shell">
      <Toolbar
        title="Key Tester"
        sub={profile ? ` — ${profile}` : undefined}
      >
        <span className="muted" style={{ fontSize: 11 }}>hover to pause scroll</span>
        <button className="btn" onClick={handleClear} aria-label="Clear key tester history">
          Clear
        </button>
      </Toolbar>

      <div className="screen-content">
        {/* Column headers */}
        <div className="tester-cols-header">
          <div className="tester-col-label">You pressed</div>
          <div className="tester-col-label">Apps received</div>
        </div>

        {/* Event list */}
        <div
          ref={listRef}
          className="tester-list"
          onMouseEnter={() => { hoverRef.current = true; }}
          onMouseLeave={() => { hoverRef.current = false; }}
          role="log"
          aria-label="Key event log"
          aria-live="polite"
          style={{ flex: 1 }}
        >
          {displayRows.length === 0 ? (
            <div className="tester-empty">Press any key to start recording…</div>
          ) : (
            displayRows.map((row) => <RowItem key={row.id} row={row} />)
          )}
        </div>
      </div>
    </div>
  );
}
