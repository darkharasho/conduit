import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { version as appVersion } from "../../package.json";
import { getStatus, suspend, resume, onStatus, onConnection } from "../lib/client";
import type { Status } from "../lib/client";

/**
 * Custom titlebar for the frameless window (`decorations: false`).
 *
 * Owns the Pause Conduit control — seeded from getStatus() on mount so the
 * button shows the correct state immediately. Disabled when disconnected.
 *
 * The bar (and its passive labels) carry `data-tauri-drag-region`, which makes
 * them a compositor drag handle; double-click toggles maximize (handled by
 * Tauri). Window controls call the window API lazily so the component renders
 * fine outside Tauri (vitest/jsdom).
 */
interface Props {
  /** Navigate to the Settings screen (gear icon). Hidden when omitted. */
  onOpenSettings?: () => void;
  /** Navigate to Help & troubleshooting (question-mark icon). Hidden when omitted. */
  onOpenHelp?: () => void;
}

export function Titlebar({ onOpenSettings, onOpenHelp }: Props = {}) {
  const [suspended, setSuspended] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);

  const win = () => getCurrentWindow();

  useEffect(() => {
    // Seed initial state from a one-shot call
    getStatus()
      .then((s: Status) => {
        setSuspended(s.suspended);
        setConnected(true);
      })
      .catch(() => {
        setConnected(false);
      });

    // Keep in sync with push events
    const unlistenStatus = onStatus((s: Status) => {
      setSuspended(s.suspended);
      setConnected(true);
    });

    // Track connection state so button can be disabled when disconnected
    const unlistenConn = onConnection((c) => {
      setConnected(c);
    });

    return () => {
      unlistenStatus.then((f) => f());
      unlistenConn.then(([f1, f2]) => { f1(); f2(); });
    };
  }, []);

  const handlePause = async () => {
    try {
      await suspend();
    } catch {
      // Errors surface in the banner / status; swallow here
    }
  };

  const handleResume = async () => {
    try {
      await resume();
    } catch {
      // Errors surface in the banner / status; swallow here
    }
  };

  return (
    <div className="titlebar" data-tauri-drag-region>
      <svg
        className="titlebar__mark"
        data-tauri-drag-region
        viewBox="0 0 1024 1024"
        aria-hidden="true"
      >
        <path
          d="M 724 724 A 300 300 0 1 1 724 300"
          fill="none"
          stroke="#38bdf8"
          strokeWidth="168"
          strokeLinecap="round"
        />
        <circle cx="724" cy="300" r="150" fill="var(--bg-rail, #14171c)" />
        <circle cx="724" cy="300" r="96" fill="#e8f7fa" />
      </svg>
      <span className="titlebar__logo" data-tauri-drag-region>
        Conduit
      </span>
      <span className="titlebar__version" data-tauri-drag-region>
        v{appVersion}
      </span>
      <span className="titlebar__spacer" data-tauri-drag-region />
      <button
        className="titlebar__pause"
        disabled={connected === false}
        title={suspended ? "Resume Conduit" : "Pause Conduit — your buttons go back to their normal behavior"}
        onClick={suspended ? handleResume : handlePause}
      >
        {suspended ? "Resume" : "Pause Conduit"}
      </button>
      {onOpenHelp && (
        <button
          className="titlebar__icon-btn"
          aria-label="Help & troubleshooting"
          title="Help & troubleshooting"
          onClick={onOpenHelp}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
            <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" strokeWidth="2.4" />
          </svg>
        </button>
      )}
      {onOpenSettings && (
        <button
          className="titlebar__icon-btn"
          aria-label="Settings"
          title="Settings"
          onClick={onOpenSettings}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      )}
      <span className="titlebar__divider" aria-hidden="true" />
      <button
        className="titlebar__btn"
        aria-label="Minimize"
        onClick={() => win().minimize()}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <line x1="1.5" y1="6" x2="10.5" y2="6" />
        </svg>
      </button>
      <button
        className="titlebar__btn"
        aria-label="Maximize"
        onClick={() => win().toggleMaximize()}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1" />
        </svg>
      </button>
      <button
        className="titlebar__btn titlebar__btn--close"
        aria-label="Close"
        onClick={() => win().close()}
      >
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <line x1="2" y1="2" x2="10" y2="10" />
          <line x1="10" y1="2" x2="2" y2="10" />
        </svg>
      </button>
    </div>
  );
}
