import { useEffect, useState } from "react";
import { getStatus, suspend, resume, onStatus, onConnection } from "../lib/client";
import type { Status } from "../lib/client";

interface Props {
  title: string;
  sub?: string;
  children?: React.ReactNode;
}

/**
 * Shared screen toolbar: title, optional context text, arbitrary children
 * (screen-specific controls), and the Suspend/Resume amber button on the right.
 *
 * Seeded from getStatus() on mount so the button shows the correct state
 * immediately without waiting for a push event. Disabled when disconnected.
 */
export function Toolbar({ title, sub, children }: Props) {
  const [suspended, setSuspended] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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

  const handleSuspend = async () => {
    setActionError(null);
    try {
      await suspend();
    } catch (err) {
      setActionError(`Suspend failed: ${String(err)}`);
    }
  };

  const handleResume = async () => {
    setActionError(null);
    try {
      await resume();
    } catch (err) {
      setActionError(`Resume failed: ${String(err)}`);
    }
  };

  const isDisconnected = connected === false;

  return (
    <div className="toolbar">
      <span className="toolbar__title">
        {title}
        {sub && <small className="toolbar__sub">{sub}</small>}
      </span>

      {children}

      <span className="toolbar__spacer" />

      {actionError && (
        <span className="muted" style={{ fontSize: 11, color: "var(--red)" }}>
          {actionError}
        </span>
      )}

      <button
        className="btn btn--warn"
        onClick={suspended ? handleResume : handleSuspend}
        title={suspended ? "Resume remapping" : "Suspend remapping"}
        disabled={isDisconnected}
      >
        {suspended ? "Resume" : "Suspend"}
      </button>
    </div>
  );
}
