import { useEffect, useState } from "react";
import {
  listDevices,
  getConfig,
  setConfig,
  onStatus,
  onConnection,
} from "../lib/client";
import type { DeviceInfo } from "../lib/client";
import {
  parseConfigToml,
  serializeConfigToml,
  getDeviceGrabs,
  setKeyboardGrab,
  setMouseGrab,
} from "../lib/config-model";
import type { ConfigModel } from "../lib/config-model";
import { Toolbar } from "../components/Toolbar";

function toHex(n: number): string {
  return n.toString(16).padStart(4, "0");
}

export function DevicesScreen() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [config, setConfigModel] = useState<ConfigModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deviceErrors, setDeviceErrors] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState<boolean | null>(null);

  // Pending keyboard toggle confirmation (inline panel — not browser confirm)
  const [pendingKbToggle, setPendingKbToggle] = useState<{
    device: DeviceInfo;
    grabbed: boolean;
    grabAllWasTrue: boolean;
    currentlyGrabbed: string[];
  } | null>(null);

  const fetchAll = async () => {
    try {
      const [devs, toml] = await Promise.all([listDevices(), getConfig()]);
      setDevices(devs);
      setConfigModel(parseConfigToml(toml));
      setLoadError(null);
    } catch (err) {
      setLoadError(String(err));
    }
  };

  useEffect(() => {
    fetchAll();

    const unlistenStatus = onStatus(() => fetchAll());
    const unlistenConn = onConnection((c) => {
      setConnected(c);
      if (c) fetchAll();
    });

    return () => {
      unlistenStatus.then((f) => f());
      unlistenConn.then(([f1, f2]) => { f1(); f2(); });
    };
  }, []);

  const clearDeviceError = (name: string) => {
    setDeviceErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const setDeviceError = (name: string, msg: string) =>
    setDeviceErrors((prev) => ({ ...prev, [name]: msg }));

  const applyConfig = async (newModel: ConfigModel) => {
    const toml = serializeConfigToml(newModel);
    await setConfig(toml);
    setConfigModel(newModel);
  };

  const doKeyboardToggle = async (
    device: DeviceInfo,
    grabbed: boolean,
    currentlyGrabbed: string[]
  ) => {
    if (!config) return;
    clearDeviceError(device.name);
    try {
      const newModel = setKeyboardGrab(config, device.name, grabbed, currentlyGrabbed);
      await applyConfig(newModel);
    } catch (err) {
      setDeviceError(device.name, String(err));
    }
  };

  const handleKeyboardToggle = (device: DeviceInfo, newGrabbed: boolean) => {
    if (!config) return;
    const grabs = getDeviceGrabs(config);
    const currentlyGrabbed = devices
      .filter((d) => d.is_keyboard && d.grabbed)
      .map((d) => d.name);

    if (grabs.grabAllKeyboards && !newGrabbed) {
      setPendingKbToggle({
        device,
        grabbed: newGrabbed,
        grabAllWasTrue: true,
        currentlyGrabbed,
      });
      return;
    }

    doKeyboardToggle(device, newGrabbed, currentlyGrabbed);
  };

  const handleMouseToggle = async (device: DeviceInfo, newGrabbed: boolean) => {
    if (!config) return;
    clearDeviceError(device.name);
    try {
      const newModel = setMouseGrab(config, device.name, newGrabbed);
      await applyConfig(newModel);
    } catch (err) {
      setDeviceError(device.name, String(err));
    }
  };

  const confirmGrabAllConversion = async () => {
    if (!pendingKbToggle) return;
    const { device, grabbed, currentlyGrabbed } = pendingKbToggle;
    setPendingKbToggle(null);
    await doKeyboardToggle(device, grabbed, currentlyGrabbed);
  };

  const grabs = config ? getDeviceGrabs(config) : null;

  return (
    <div className="screen-shell">
      <Toolbar title="Devices" />

      <div className="screen-content">
        {connected === false && (
          <div className="banner--error" role="alert">
            Daemon unreachable — device list may be stale
          </div>
        )}

        {loadError && (
          <div className="banner--error" role="alert">
            Failed to load devices: {loadError}
          </div>
        )}

        {/* Inline confirm panel (replaces window.confirm) */}
        {pendingKbToggle && (
          <div className="confirm-panel" role="dialog" aria-modal="true">
            <div className="confirm-panel__title">Change keyboard grab mode</div>
            <div className="confirm-panel__body">
              Currently <strong>all keyboards</strong> are grabbed automatically
              (<span className="mono" style={{ fontSize: 11, color: "var(--text-lo)" }}>grab_all_keyboards = true</span>).
              Ungrabbing <strong>{pendingKbToggle.device.name}</strong> will
              switch to an explicit list. Only the currently-grabbed keyboards
              (minus this one) will be grabbed going forward.
            </div>
            {pendingKbToggle.currentlyGrabbed.filter((n) => n !== pendingKbToggle.device.name).length > 0 && (
              <>
                <div className="muted" style={{ fontSize: 11 }}>Keyboards that will remain grabbed:</div>
                <ul className="confirm-panel__list">
                  {pendingKbToggle.currentlyGrabbed
                    .filter((n) => n !== pendingKbToggle.device.name)
                    .map((n) => <li key={n}>{n}</li>)}
                </ul>
              </>
            )}
            <div className="confirm-panel__actions">
              <button className="btn btn--primary" onClick={confirmGrabAllConversion}>
                Switch to explicit list
              </button>
              <button className="btn" onClick={() => setPendingKbToggle(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {grabs?.grabAllKeyboards && (
          <div className="banner--info">
            All keyboards grabbed automatically (
            <code>grab_all_keyboards = true</code>).
            Uncheck a keyboard to switch to an explicit list.
          </div>
        )}

        {devices.length === 0 && !loadError ? (
          <p className="muted" style={{ fontSize: 12 }}>No devices found.</p>
        ) : (
          <table className="devices-table">
            <thead>
              <tr>
                <th>Device name</th>
                <th>Vendor:Product</th>
                <th>Type</th>
                <th>Grabbed</th>
              </tr>
            </thead>
            <tbody>
              {devices.map((dev) => {
                const isKeyboard = dev.is_keyboard;
                const isMouse = dev.is_mouse;

                let isGrabbed = dev.grabbed;
                if (grabs) {
                  if (isKeyboard) {
                    isGrabbed = grabs.grabAllKeyboards || grabs.grabKeyboards.includes(dev.name);
                  } else if (isMouse) {
                    isGrabbed = grabs.grabMice.includes(dev.name);
                  }
                }

                const canToggle = isKeyboard || isMouse;
                const err = deviceErrors[dev.name];

                return (
                  <tr key={dev.path}>
                    <td className="devices-table__name">{dev.name}</td>
                    <td className="devices-table__vid-pid">
                      {toHex(dev.vendor)}:{toHex(dev.product)}
                    </td>
                    <td>
                      {isKeyboard && <span className="dev-badge dev-badge--keyboard">Keyboard</span>}
                      {isMouse && <span className="dev-badge dev-badge--mouse">Mouse</span>}
                      {!isKeyboard && !isMouse && <span className="dev-badge dev-badge--other">Other</span>}
                    </td>
                    <td className="devices-table__grab">
                      {canToggle ? (
                        <label className="grab-toggle">
                          <input
                            type="checkbox"
                            checked={isGrabbed}
                            onChange={(e) => {
                              if (isKeyboard) handleKeyboardToggle(dev, e.target.checked);
                              else handleMouseToggle(dev, e.target.checked);
                            }}
                            disabled={!config}
                          />
                          <span
                            className={`grab-dot ${isGrabbed ? "grab-dot--on" : "grab-dot--off"}`}
                            aria-label={isGrabbed ? "grabbed" : "not grabbed"}
                          />
                        </label>
                      ) : (
                        <span className="muted">—</span>
                      )}
                      {err && (
                        <div className="devices-table__error" role="alert">{err}</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
