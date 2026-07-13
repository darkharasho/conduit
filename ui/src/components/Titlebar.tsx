import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
export function Titlebar() {
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
      <span className="titlebar__logo" data-tauri-drag-region>
        Conduit
      </span>
      <span className="titlebar__version" data-tauri-drag-region>
        v0.1
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
      <button
        className="titlebar__btn"
        aria-label="Minimize"
        onClick={() => win().minimize()}
      >
        ─
      </button>
      <button
        className="titlebar__btn"
        aria-label="Maximize"
        onClick={() => win().toggleMaximize()}
      >
        ▢
      </button>
      <button
        className="titlebar__btn titlebar__btn--close"
        aria-label="Close"
        onClick={() => win().close()}
      >
        ✕
      </button>
    </div>
  );
}
