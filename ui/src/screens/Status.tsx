import { useEffect, useState } from "react";
import {
  getStatus,
  suspend,
  resume,
  onStatus,
  onConnection,
} from "../lib/client";
import type { Status as StatusData } from "../lib/client";

export function StatusScreen() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    // Fetch initial status
    getStatus()
      .then((s) => {
        setStatus(s);
        setConnected(true);
        setError(null);
      })
      .catch((err) => {
        setConnected(false);
        setError(String(err));
      });

    // Subscribe to live status updates
    const unlistenStatus = onStatus((s) => {
      setStatus(s);
      setConnected(true);
    });

    // Subscribe to connection events
    const unlistenConn = onConnection((c) => {
      setConnected(c);
      if (c) {
        // Re-fetch on reconnect
        getStatus()
          .then(setStatus)
          .catch(() => {});
      }
    });

    return () => {
      unlistenStatus.then((fn) => fn());
      unlistenConn.then(([fn1, fn2]) => {
        fn1();
        fn2();
      });
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

  return (
    <div className="screen status-screen">
      {/* Connection banner */}
      {connected === false && (
        <div className="banner banner--error" role="alert">
          Daemon unreachable
          {error && <span className="banner__detail"> — {error}</span>}
        </div>
      )}
      {connected === true && (
        <div className="banner banner--ok" role="status">
          Daemon connected
        </div>
      )}

      <h2 className="screen__title">Status</h2>

      {status ? (
        <div className="status-grid">
          <section className="status-card">
            <div className="status-card__label">Active Profile</div>
            <div className="status-card__value status-card__value--primary">
              {status.active_profile}
            </div>
          </section>

          <section className="status-card">
            <div className="status-card__label">Active Layers</div>
            <div className="status-card__value">
              {status.active_layers.length > 0 ? (
                <ul className="layer-list">
                  {status.active_layers.map((layer) => (
                    <li key={layer} className="layer-list__item">
                      {layer}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="muted">none</span>
              )}
            </div>
          </section>

          <section className="status-card">
            <div className="status-card__label">Remapping State</div>
            <div className="status-card__value">
              <span
                className={`badge ${
                  status.suspended ? "badge--warn" : "badge--ok"
                }`}
              >
                {status.suspended ? "Suspended" : "Active"}
              </span>
              <div className="suspend-actions">
                {status.suspended ? (
                  <button
                    className="btn btn--primary"
                    onClick={handleResume}
                    disabled={!connected}
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    className="btn btn--secondary"
                    onClick={handleSuspend}
                    disabled={!connected}
                  >
                    Suspend
                  </button>
                )}
              </div>
              {actionError && (
                <div className="action-error">{actionError}</div>
              )}
            </div>
          </section>

          <section className="status-card">
            <div className="status-card__label">Grabbed Devices</div>
            <div className="status-card__value">
              <span className="count">{status.grabbed_devices.length}</span>
              {status.grabbed_devices.length > 0 && (
                <ul className="device-list">
                  {status.grabbed_devices.map((dev) => (
                    <li key={dev} className="device-list__item">
                      {dev}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {status.focus && (
            <section className="status-card">
              <div className="status-card__label">Focus</div>
              <div className="status-card__value">
                <span className="focus-process">{status.focus.process}</span>
                <span className="muted"> — {status.focus.title}</span>
              </div>
            </section>
          )}

          <section className="status-card">
            <div className="status-card__label">Daemon Version</div>
            <div className="status-card__value muted">{status.version}</div>
          </section>
        </div>
      ) : (
        <div className="status-placeholder">
          {connected === false
            ? "Cannot reach daemon."
            : "Loading status..."}
        </div>
      )}
    </div>
  );
}
