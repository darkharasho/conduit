import { useEffect, useState } from "react";
import { suspend, resume, onStatus } from "../lib/client";
import type { Status } from "../lib/client";

interface Props {
  title: string;
  sub?: string;
  children?: React.ReactNode;
}

/**
 * Shared screen toolbar: title, optional context text, arbitrary children
 * (screen-specific controls), and the Suspend/Resume amber button on the right.
 */
export function Toolbar({ title, sub, children }: Props) {
  const [suspended, setSuspended] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const p = onStatus((s: Status) => setSuspended(s.suspended));
    return () => { p.then((f) => f()); };
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
      >
        {suspended ? "Resume" : "Suspend"}
      </button>
    </div>
  );
}
