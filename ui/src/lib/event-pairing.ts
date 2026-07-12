import type { WireEvent } from "./client";

// ---- Public types ----

export interface TesterRow {
  id: number;
  pre: { name: string; state: string; timeUs: number };
  post: { name: string; state: string; timeUs: number }[];
  resolution?: string;
  /** Count of pre REPEAT events seen while this row was open. */
  repeats?: number;
  /** Whether this row is still open (pre-release not yet seen). Internal use. */
  _open?: boolean;
  /** Time of the pre RELEASE event, stored for resolution recomputation. Internal. */
  _releaseTimeUs?: number;
}

// ---- Constants ----

const MAX_ROWS = 100;
const TAP_HOLD_THRESHOLD_US = 5_000; // 5 ms in microseconds

// ---- Helpers ----

function nextId(rows: TesterRow[]): number {
  if (rows.length === 0) return 1;
  return Math.max(...rows.map((r) => r.id)) + 1;
}

/** Return the index of the most recent open row, or -1 if none. */
function lastOpenIndex(rows: TesterRow[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i]._open) return i;
  }
  return -1;
}

/**
 * Compute resolution string for a closed row.
 *   - No posts at all                         → "(swallowed)"
 *   - Posts exist, first post key ≠ pre key AND hold duration > 5 ms → "held {ms}ms → {name}"
 *   - Posts exist, first post key ≠ pre key AND hold duration ≤ 5 ms → "→ {name}"
 *   - Posts exist, first post key === pre key                         → undefined (passthrough)
 *
 * Hold duration = pre-release time - pre-press time (if release time known),
 * otherwise falls back to first-post time - pre-press time.
 */
function computeResolution(row: TesterRow): string | undefined {
  if (row.post.length === 0) return "(swallowed)";

  const firstPost = row.post[0];
  const preName = row.pre.name;

  if (firstPost.name !== preName) {
    // Use release time for the hold duration if available, else use first post time
    const endTimeUs = row._releaseTimeUs ?? firstPost.timeUs;
    const deltaUs = endTimeUs - row.pre.timeUs;
    if (deltaUs > TAP_HOLD_THRESHOLD_US) {
      const ms = Math.round(deltaUs / 1_000);
      return `held ${ms}ms → ${firstPost.name}`;
    }
    return `→ ${firstPost.name}`;
  }

  return undefined;
}

// ---- Core reducer ----

/**
 * Pure reducer: given the current list of rows and one incoming WireEvent,
 * return a new list of rows (never mutates the input array).
 */
export function reduceEvents(rows: TesterRow[], ev: WireEvent): TesterRow[] {
  if (ev.phase === "pre") {
    // --- PRE PRESS: start a new row ---
    if (ev.state === "press") {
      const newRow: TesterRow = {
        id: nextId(rows),
        pre: { name: ev.key_name, state: ev.state, timeUs: ev.time_us },
        post: [],
        _open: true,
      };
      const next = [...rows, newRow];
      // Trim to MAX_ROWS (keep newest)
      if (next.length > MAX_ROWS) return next.slice(next.length - MAX_ROWS);
      return next;
    }

    // --- PRE REPEAT: increment counter on the open row ---
    if (ev.state === "repeat") {
      const openIdx = lastOpenIndex(rows);
      if (openIdx === -1) return rows; // no open row — ignore
      return rows.map((r, i) => {
        if (i !== openIdx) return r;
        return { ...r, repeats: (r.repeats ?? 0) + 1 };
      });
    }

    // --- PRE RELEASE: close the most recent open row with the same key name ---
    if (ev.state === "release") {
      // Find the most recent open row matching this key name
      let closeIdx = -1;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i]._open && rows[i].pre.name === ev.key_name) {
          closeIdx = i;
          break;
        }
      }
      if (closeIdx === -1) return rows; // no matching open row — ignore

      return rows.map((r, i) => {
        if (i !== closeIdx) return r;
        const closed = { ...r, _open: false, _releaseTimeUs: ev.time_us };
        closed.resolution = computeResolution(closed);
        return closed;
      });
    }

    return rows;
  }

  // --- POST event: attach to the most recent open row ---
  if (ev.phase === "post") {
    const openIdx = lastOpenIndex(rows);

    if (openIdx !== -1) {
      // Attach to the most recent open row
      return rows.map((r, i) => {
        if (i !== openIdx) return r;
        return {
          ...r,
          post: [
            ...r.post,
            { name: ev.key_name, state: ev.state, timeUs: ev.time_us },
          ],
        };
      });
    }

    // No open row: attach to the newest row (replay burst after resolution)
    if (rows.length === 0) return rows; // nothing to attach to
    const newestIdx = rows.length - 1;
    return rows.map((r, i) => {
      if (i !== newestIdx) return r;
      const updated = {
        ...r,
        post: [
          ...r.post,
          { name: ev.key_name, state: ev.state, timeUs: ev.time_us },
        ],
      };
      // Recompute resolution since we now have post data (row was closed as swallowed)
      if (!r._open) {
        updated.resolution = computeResolution(updated);
      }
      return updated;
    });
  }

  return rows;
}
