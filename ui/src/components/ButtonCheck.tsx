/**
 * ButtonCheck.tsx — guided button-check panel (Task 4) + onboard fix wizard (Task 6).
 *
 * Listens to pre-phase key events from the active device, accumulates
 * PressSamples, and on Done produces a plain-language CollisionReport verdict.
 *
 * When the device is in the curated fixable set, the collision verdict shows
 * "Fix this mouse's memory" which opens an inline fix wizard that:
 *   1. Checks ratbagd status (stages + installs drop-in if needed, one pkexec prompt)
 *   2. Reads the onboard button map and suggests rewrites
 *   3. Shows a confirm sheet listing each button change + verbatim footer
 *   4. On confirm: rewrites the buttons, then auto-runs a new press-check
 *
 * Jargon policy: ratbagd, HID++, KEY_* names, and raw code numbers are ONLY
 * shown inside the "Show technical details" collapsible pane.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import {
  onKeyEvent,
  ratbagGetStatus,
  ratbagStageDeviceFile,
  ratbagFixSetup,
  ratbagReadButtons,
  ratbagSuggestRewrites,
  ratbagRewrite,
  ConduitError,
} from "../lib/client";
import type { DeviceInfo, OnboardButtonDto } from "../lib/client";
import { analyzePresses, isOnboardFixable } from "../lib/button-check";
import type { CollisionReport, PressSample } from "../lib/button-check";
import { presentError } from "../lib/error-messages";

// Re-export for consumers that import from this component file
export { isOnboardFixable };

// ── Fix wizard state machine ─────────────────────────────────────────────────

type FixPhase =
  | { kind: "idle" }
  | { kind: "preparing" }              // staging device file + pkexec
  | { kind: "reading" }               // ratbag_read_buttons in flight
  | { kind: "confirm"; buttons: OnboardButtonDto[]; targets: [number, string][] }
  | { kind: "rewriting" }             // ratbag_rewrite in flight
  | { kind: "recheck" }               // rewrite done; pressing buttons again to verify
  | { kind: "error"; title: string; detail: string };

// ── Component ────────────────────────────────────────────────────────────────

interface Props {
  device: DeviceInfo;
  onClose: () => void;
  /** Provided by the caller only when isOnboardFixable(device) is true. */
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
  // Fix wizard phase
  const [fixPhase, setFixPhase] = useState<FixPhase>({ kind: "idle" });
  // Track whether we are in the post-rewrite re-check mode
  const [isRecheck, setIsRecheck] = useState(false);

  // Keep a ref to the current samples so the event handler always sees fresh data
  const samplesRef = useRef<PressSample[]>([]);
  // Ref to the seen codes set for resetting between phases
  const seenCodesRef = useRef<Set<number>>(new Set());
  // Ref to last code for transition tracking
  const lastCodeRef = useRef<number | null>(null);
  // Tracks whether the component is still mounted — used by the poll loop to
  // prevent state updates after unmount (avoids act() warnings in tests).
  const mountedRef = useRef(true);

  const deviceName = device.name;

  // Subscribe to key events filtered by the active device.
  // Re-subscribes when isRecheck changes (to reset the press-check phase).
  useEffect(() => {
    // Reset tracking state on each subscription
    samplesRef.current = [];
    seenCodesRef.current = new Set();
    lastCodeRef.current = null;

    let alive = true;
    let unlisten: (() => void) | null = null;

    const sub = onKeyEvent((ev) => {
      if (!alive) return;
      if (ev.phase !== "pre") return;
      if (ev.state !== "press") return;
      if (ev.device !== deviceName) return;

      const sample: PressSample = { code: ev.code, keyName: ev.key_name };

      const isNew = !seenCodesRef.current.has(ev.code);
      if (isNew) seenCodesRef.current.add(ev.code);

      const isTransition = lastCodeRef.current === null || ev.code !== lastCodeRef.current;
      lastCodeRef.current = ev.code;

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
  }, [deviceName, isRecheck]);

  // Track component lifetime so the poll loop can bail out after unmount.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function handleDone() {
    const result = analyzePresses(samplesRef.current, device.class);
    setReport(result);
  }

  // ── Fix wizard logic ─────────────────────────────────────────────────────────

  const runFixWizard = useCallback(async () => {
    setShowTech(false);

    try {
      // Step 1: Check ratbagd status
      const status = await ratbagGetStatus();

      let deviceId = status.device_id;

      if (!deviceId) {
        // Device not yet known to ratbagd — need to stage + setup.
        // Only show "preparing" when the device is actually missing.
        setFixPhase({ kind: "preparing" });

        let stagedPath: string;
        try {
          stagedPath = await ratbagStageDeviceFile();
        } catch (e) {
          const err = e instanceof ConduitError ? e : new ConduitError("internal", String(e));
          const pres = presentError(err);
          setFixPhase({
            kind: "error",
            title: pres.title,
            detail: err.detail,
          });
          return;
        }

        try {
          await ratbagFixSetup(stagedPath);
        } catch (e) {
          const err = e instanceof ConduitError ? e : (() => {
            // Handle plain object rejection from mock (code/message/detail shape)
            if (typeof e === "object" && e !== null && "code" in e) {
              const p = e as { code: string; message: string; detail?: string };
              return new ConduitError(
                p.code === "permission-denied" ? "permission-denied" : "internal",
                (p as { message: string }).message,
                (p as { detail?: string }).detail ?? ""
              );
            }
            return new ConduitError("internal", String(e));
          })();
          const pres = presentError(err);
          // pkexec dismissal: map to human-friendly message
          const title =
            err.code === "permission-denied"
              ? "You closed the password prompt"
              : pres.title;
          setFixPhase({
            kind: "error",
            title,
            detail: err.detail,
          });
          return;
        }

        // Poll for device to appear (≤10 s, 500 ms interval).
        // Bail out immediately if the component unmounts during the wait.
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          if (!mountedRef.current) return; // component unmounted — stop
          try {
            const s2 = await ratbagGetStatus();
            if (s2.device_id) {
              deviceId = s2.device_id;
              break;
            }
          } catch {
            // ignore poll errors
          }
        }

        if (!deviceId) {
          if (!mountedRef.current) return; // unmounted before we could report
          setFixPhase({
            kind: "error",
            title: "The mouse wasn't found after setup",
            detail: "ratbagd did not detect the device within 10 s of setup completion.",
          });
          return;
        }
      }

      // Step 2: Read buttons
      setFixPhase({ kind: "reading" });

      let buttons: OnboardButtonDto[];
      try {
        buttons = await ratbagReadButtons(deviceId);
      } catch (e) {
        const err = e instanceof ConduitError ? e : new ConduitError("internal", String(e));
        const pres = presentError(err);
        setFixPhase({ kind: "error", title: pres.title, detail: err.detail });
        return;
      }

      // Compute suggested rewrites (pure Rust logic exposed via IPC)
      let targets: [number, string][];
      try {
        targets = await ratbagSuggestRewrites(
          buttons.map((b) => ({ index: b.index, action: b.action }))
        );
      } catch (e) {
        const err = e instanceof ConduitError ? e : new ConduitError("internal", String(e));
        const pres = presentError(err);
        setFixPhase({ kind: "error", title: pres.title, detail: err.detail });
        return;
      }

      // Show confirm sheet
      setFixPhase({ kind: "confirm", buttons, targets });
    } catch (e) {
      const err = e instanceof ConduitError ? e : new ConduitError("internal", String(e));
      const pres = presentError(err);
      setFixPhase({ kind: "error", title: pres.title, detail: err.detail });
    }
  }, []);

  const handleConfirmRewrite = useCallback(async (
    deviceId: string,
    targets: [number, string][]
  ) => {
    setFixPhase({ kind: "rewriting" });
    try {
      await ratbagRewrite(deviceId, targets);
    } catch (e) {
      const err = e instanceof ConduitError ? e : (() => {
        if (typeof e === "object" && e !== null && "code" in e) {
          const p = e as { code: string; message: string; detail?: string };
          return new ConduitError("internal", p.message, p.detail ?? "");
        }
        return new ConduitError("internal", String(e));
      })();
      const pres = presentError(err);
      setFixPhase({ kind: "error", title: pres.title, detail: err.detail });
      return;
    }
    // Rewrite done — enter the re-check phase
    setFixPhase({ kind: "recheck" });
    setReport(null);
    setDistinctCount(0);
    setPressCount(0);
    setIsRecheck((v) => !v); // toggle to re-run the key event subscription effect
  }, []);

  // ── Verdict copy ────────────────────────────────────────────────────────────
  function renderVerdict() {
    if (!report) return null;

    if (report.collisions.length === 0) {
      // Distinguish re-check success from initial all-clear
      const allClearText = isRecheck
        ? `All ${report.distinct} buttons are now distinct.`
        : `All ${report.distinct} buttons send distinct signals. You're all set.`;
      return (
        <div className="btn-check__verdict btn-check__verdict--ok">
          <p className="btn-check__verdict-text">{allClearText}</p>
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
          <button
            className="btn btn--primary btn-check__fix-btn"
            onClick={() => void runFixWizard()}
          >
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

  // ── Fix wizard rendering ─────────────────────────────────────────────────────

  function renderFixWizard() {
    const phase = fixPhase;

    if (phase.kind === "idle") return null;

    if (phase.kind === "preparing") {
      return (
        <div className="fix-wizard">
          <p className="fix-wizard__status">
            Preparing the fix — you&apos;ll be asked for your password once.
          </p>
          <span className="fix-wizard__spinner" aria-label="Working…" />
        </div>
      );
    }

    if (phase.kind === "reading") {
      return (
        <div className="fix-wizard">
          <p className="fix-wizard__status">Reading your mouse&apos;s current button assignments…</p>
          <span className="fix-wizard__spinner" aria-label="Working…" />
        </div>
      );
    }

    if (phase.kind === "rewriting") {
      return (
        <div className="fix-wizard">
          <p className="fix-wizard__status">Rewriting button assignments…</p>
          <span className="fix-wizard__spinner" aria-label="Working…" />
        </div>
      );
    }

    if (phase.kind === "confirm") {
      const { buttons, targets } = phase;
      // Build a map from button index → target action
      const targetMap = new Map(targets.map(([idx]) => [idx, true]));
      // Filter buttons to those that are rewrite targets
      const targetButtons = buttons.filter((b) => targetMap.has(b.index));
      const n = targets.length;
      const btnLabel = n === 1 ? `Rewrite 1 button` : `Rewrite ${n} buttons`;

      // We need the device_id to pass to ratbagRewrite — re-fetch from status
      // (we stored the deviceId in the wizard flow but not in state; use a workaround:
      //  look up from the status cached at wizard-start via a separate read)
      // Simpler: call ratbagGetStatus() again in the confirm handler.
      const handleRewrite = async () => {
        let devId: string | null = null;
        try {
          const s = await ratbagGetStatus();
          devId = s.device_id;
        } catch {
          // ignore
        }
        if (!devId) {
          setFixPhase({
            kind: "error",
            title: "Mouse not found",
            detail: "ratbagd could not find the device at rewrite time.",
          });
          return;
        }
        await handleConfirmRewrite(devId, targets);
      };

      return (
        <div className="fix-wizard fix-wizard--confirm">
          <p className="fix-wizard__confirm-heading">These buttons will get their own signals:</p>
          <ul className="fix-wizard__change-list">
            {targetButtons.map((b) => (
              <li key={b.index} className="fix-wizard__change-row">
                <span className="fix-wizard__change-label">{b.human}</span>
                <span className="fix-wizard__change-arrow">→</span>
                <span className="fix-wizard__change-result">will send its own signal</span>
              </li>
            ))}
          </ul>
          <p className="fix-wizard__footer">
            This changes the mouse&apos;s own memory — other computers (and G HUB) will see these assignments too.
          </p>
          <div className="fix-wizard__confirm-actions">
            <button
              className="btn btn--primary"
              onClick={() => void handleRewrite()}
            >
              {btnLabel}
            </button>
            <button
              className="btn"
              onClick={() => setFixPhase({ kind: "idle" })}
            >
              Cancel
            </button>
          </div>
        </div>
      );
    }

    if (phase.kind === "error") {
      return (
        <div className="fix-wizard fix-wizard--error">
          <p className="fix-wizard__error-title">{phase.title}</p>
          <div className="fix-wizard__tech">
            <button
              className="assign-adv-link"
              onClick={() => setShowTech((v) => !v)}
            >
              {showTech ? "Hide technical details" : "Show technical details"}
            </button>
            {showTech && phase.detail && (
              <pre className="fix-wizard__tech-body">{phase.detail}</pre>
            )}
          </div>
          <div className="fix-wizard__error-actions">
            <button
              className="btn"
              onClick={() => {
                setFixPhase({ kind: "idle" });
                setShowTech(false);
              }}
            >
              Back
            </button>
          </div>
        </div>
      );
    }

    return null;
  }

  // ── Layout ──────────────────────────────────────────────────────────────────

  const inWizard = fixPhase.kind !== "idle" && fixPhase.kind !== "recheck";
  const inRecheck = fixPhase.kind === "recheck";

  return (
    <div className="btn-check">
      <div className="btn-check__header">
        <span className="btn-check__title">Button check</span>
        <button className="modal__close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="btn-check__body">
        {inWizard ? (
          /* Fix wizard replaces normal content */
          renderFixWizard()
        ) : !report ? (
          <>
            <p className="btn-check__intro">
              {inRecheck
                ? `Press the fixed buttons to confirm`
                : `Press each button on your ${device.name} once — any order.`}
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
