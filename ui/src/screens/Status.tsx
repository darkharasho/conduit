import { useEffect, useState } from "react";
import { getStatus, onStatus, onConnection } from "../lib/client";
import type { Status as StatusData } from "../lib/client";
import { SetupScreen } from "./Setup";
import { Toolbar } from "../components/Toolbar";

export function StatusScreen() {
  const [status, setStatus] = useState<StatusData | null>(null);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStatus()
      .then((s) => { setStatus(s); setConnected(true); setError(null); })
      .catch((err) => { setConnected(false); setError(String(err)); });

    const unlistenStatus = onStatus((s) => { setStatus(s); setConnected(true); });
    const unlistenConn = onConnection((c) => {
      setConnected(c);
      if (c) getStatus().then(setStatus).catch(() => {});
    });

    return () => {
      unlistenStatus.then((f) => f());
      unlistenConn.then(([f1, f2]) => { f1(); f2(); });
    };
  }, []);

  return (
    <div className="screen-shell">
      <Toolbar title="Status" />

      <div className="screen-content">
        {/* Connection banner */}
        {connected === false && (
          <div className="banner--error" role="alert">
            Daemon unreachable{error ? ` — ${error}` : ""}
          </div>
        )}
        {connected === true && !status && (
          <div className="banner--ok" role="status">Daemon connected</div>
        )}

        {/* Setup check (when not connected) */}
        {connected === false && <SetupScreen variant="recovery" />}

        {/* Status definition-list panels */}
        {status && (
          <div className="status-panels">
            <div className="status-panel">
              {/* Daemon */}
              <div className="status-panel__row">
                <dt className="status-panel__dt">Daemon</dt>
                <dd className="status-panel__dd">
                  <span className={`status-dot ${connected ? "status-dot--ok" : "status-dot--err"}`} />
                  {connected ? "connected" : "unreachable"}
                  <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>{status.version}</span>
                </dd>
              </div>

              {/* Remapping state */}
              <div className="status-panel__row">
                <dt className="status-panel__dt">Remapping</dt>
                <dd className="status-panel__dd">
                  <span className={`status-dot ${status.suspended ? "status-dot--warn" : "status-dot--ok"}`} />
                  {status.suspended ? "suspended" : "active"}
                </dd>
              </div>

              {/* Active profile */}
              <div className="status-panel__row">
                <dt className="status-panel__dt">Profile</dt>
                <dd className="status-panel__dd" style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                  {status.active_profile}
                </dd>
              </div>

              {/* Active layers */}
              <div className="status-panel__row">
                <dt className="status-panel__dt">Layers</dt>
                <dd className="status-panel__dd">
                  {status.active_layers.length > 0 ? (
                    status.active_layers.map((l) => (
                      <span key={l} className="status-layer-chip">{l}</span>
                    ))
                  ) : (
                    <span className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>base</span>
                  )}
                </dd>
              </div>

              {/* Focus */}
              {status.focus && (
                <div className="status-panel__row">
                  <dt className="status-panel__dt">Focus</dt>
                  <dd className="status-panel__dd">
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-hi)" }}>
                      {status.focus.process}
                    </span>
                    <span className="muted" style={{ fontSize: 11 }}> — {status.focus.title}</span>
                  </dd>
                </div>
              )}

              {/* Grabbed devices */}
              <div className="status-panel__row">
                <dt className="status-panel__dt">Grabbed devices</dt>
                <dd className="status-panel__dd">
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-hi)" }}>
                    {status.grabbed_devices.length}
                  </span>
                  {status.grabbed_devices.length > 0 && (
                    <span className="muted" style={{ fontSize: 11, fontFamily: "var(--font-mono)" }}>
                      {" "}({status.grabbed_devices.join(", ")})
                    </span>
                  )}
                </dd>
              </div>
            </div>
          </div>
        )}

        {!status && !error && (
          <span className="muted" style={{ fontSize: 12 }}>Loading status…</span>
        )}
      </div>
    </div>
  );
}
