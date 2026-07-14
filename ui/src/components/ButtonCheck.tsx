/**
 * ButtonCheck.tsx — guided button-check panel (Task 4).
 *
 * Listens to pre-phase key events from the active device, accumulates
 * PressSamples, and on Done produces a plain-language CollisionReport verdict.
 *
 * Jargon policy: ratbagd, HID++, KEY_* names, and raw code numbers are ONLY
 * shown inside the "Show technical details" collapsible pane.
 */

import { useEffect, useRef, useState } from "react";
import { onKeyEvent } from "../lib/client";
import type { DeviceInfo } from "../lib/client";
import { analyzePresses, isOnboardFixable } from "../lib/button-check";
import type { CollisionReport, PressSample } from "../lib/button-check";

// Re-export for consumers that import from this component file
export { isOnboardFixable };

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  device: DeviceInfo;
  onClose: () => void;
  onFix?: () => void;
}

export function ButtonCheck({ device, onClose, onFix }: Props) {
  // Live distinct signal count (for tally display)
  const [distinctCount, setDistinctCount] = useState(0);
  // Live press count
  const [pressCount, setPressCount] = useState(0);
  // Verdict — set when Done is clicked
  const [report, setReport] = useState<CollisionReport | null>(null);
  // Technical pane toggle
  const [showTech, setShowTech] = useState(false);

  // Keep a ref to the current samples so the event handler always sees fresh data
  const samplesRef = useRef<PressSample[]>([]);

  const deviceName = device.name;

  // Subscribe to key events filtered by the active device
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;

    // Track last code for live tally (mirror analyzePresses heuristic)
    let lastCode: number | null = null;
    const seenCodes = new Set<number>();

    const sub = onKeyEvent((ev) => {
      if (!alive) return;
      if (ev.phase !== "pre") return;
      if (ev.state !== "press") return;
      if (ev.device !== deviceName) return;

      const sample: PressSample = { code: ev.code, keyName: ev.key_name };

      // Update live tally
      const isNew = !seenCodes.has(ev.code);
      if (isNew) seenCodes.add(ev.code);

      const isTransition = lastCode === null || ev.code !== lastCode;
      lastCode = ev.code;

      // Append to ref (used by handleDone) without triggering a re-render
      samplesRef.current = [...samplesRef.current, sample];

      if (isNew) setDistinctCount((n) => n + 1);
      if (isTransition) setPressCount((n) => n + 1);
    });

    sub.then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    });

    return () => {
      alive = false;
      if (unlisten) unlisten();
      else sub.then((fn) => fn());
    };
  }, [deviceName]);

  function handleDone() {
    const result = analyzePresses(samplesRef.current, device.class);
    setReport(result);
  }

  // ── Verdict copy ────────────────────────────────────────────────────────────
  function renderVerdict() {
    if (!report) return null;

    if (report.collisions.length === 0) {
      // No collisions — all-clear
      return (
        <div className="btn-check__verdict btn-check__verdict--ok">
          <p className="btn-check__verdict-text">
            {`All ${report.distinct} buttons send distinct signals. You're all set.`}
          </p>
        </div>
      );
    }

    // Collision verdict
    const k = report.collisions.length;
    const collisionCopy = `${k} of this mouse's buttons share signals, so Conduit can't tell them apart. This is stored in the mouse itself.`;

    return (
      <div className="btn-check__verdict btn-check__verdict--collision">
        <p className="btn-check__verdict-text">{collisionCopy}</p>

        {onFix ? (
          <button className="btn btn--primary btn-check__fix-btn" onClick={onFix}>
            Fix this mouse&apos;s memory
          </button>
        ) : (
          <p className="btn-check__no-fix">Conduit can&apos;t fix this mouse automatically yet.</p>
        )}

        {/* Technical details — jargon quarantine */}
        <div className="btn-check__tech">
          <button
            className="assign-adv-link"
            onClick={() => setShowTech((v) => !v)}
          >
            {showTech ? "Hide technical details" : "Show technical details"}
          </button>
          {showTech && (
            <div className="btn-check__tech-body">
              <table className="btn-check__tech-table">
                <thead>
                  <tr>
                    <th>Code (dec)</th>
                    <th>Code (hex)</th>
                    <th>Name</th>
                    <th>Presses</th>
                  </tr>
                </thead>
                <tbody>
                  {report.collisions.map((c) => (
                    <tr key={c.code}>
                      <td>{c.code}</td>
                      <td>{`0x${c.code.toString(16).toUpperCase()}`}</td>
                      <td className="mono">{c.keyName}</td>
                      <td>{c.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {report.keyboardCodes.length > 0 && (
                <p className="btn-check__tech-note">
                  Also saw keyboard-range codes:{" "}
                  {report.keyboardCodes.map((kc) => `${kc.keyName} (${kc.code})`).join(", ")}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Layout ──────────────────────────────────────────────────────────────────
  return (
    <div className="btn-check">
      <div className="btn-check__header">
        <span className="btn-check__title">Button check</span>
        <button className="modal__close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="btn-check__body">
        {!report ? (
          <>
            <p className="btn-check__intro">
              Press each button on your {device.name} once — any order.
            </p>
            <p className="btn-check__tally" aria-live="polite">
              {distinctCount} signals seen &middot; {pressCount} presses
            </p>
            <div className="btn-check__actions">
              <button className="btn btn--primary" onClick={handleDone}>
                Done
              </button>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            {renderVerdict()}
            <div className="btn-check__actions">
              <button className="btn" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
