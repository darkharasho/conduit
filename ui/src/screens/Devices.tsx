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
  setGrabAllMice,
  listMatchesDevice,
} from "../lib/config-model";
import type { ConfigModel } from "../lib/config-model";
import { Toolbar } from "../components/Toolbar";

function toHex(n: number): string {
  return n.toString(16).padStart(4, "0");
}

const CLASS_LABELS: Record<string, string> = {
  keyboard: "Keyboard",
  mouse: "Mouse",
  touchpad: "Touchpad",
  gamepad: "Gamepad",
  media: "Media",
  other: "Other",
};

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
      const newModel = setKeyboardGrab(config, device, grabbed, currentlyGrabbed);
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
      .map((d) => d.id);

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
      const newModel = setMouseGrab(config, device, newGrabbed);
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
              (<span className="mono devices__config-key">grab_all_keyboards = true</span>).
              Ungrabbing <strong>{pendingKbToggle.device.name}</strong> will
              switch to an explicit list. Only the currently-grabbed keyboards
              (minus this one) will be grabbed going forward.
            </div>
            {pendingKbToggle.currentlyGrabbed.filter((n) => n !== pendingKbToggle.device.name).length > 0 && (
              <>
                <div className="muted devices__remain-label">Keyboards that will remain grabbed:</div>
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

        {grabs && (
          <label className="grab-toggle devices__grab-all-label">
            <input
              type="checkbox"
              checked={grabs.grabAllMice}
              disabled={!config}
              onChange={(e) => {
                if (!config) return;
                applyConfig(setGrabAllMice(config, e.target.checked)).catch((err) =>
                  setLoadError(String(err))
                );
              }}
            />
            {" Grab all mice automatically ("}
            <code>grab_all_mice</code>
            {") — touchpads excluded"}
          </label>
        )}

        {devices.length === 0 && !loadError ? (
          <p className="muted devices__empty">No devices found.</p>
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
                const isKeyboard = dev.class === "keyboard";
                const isMouse = dev.class === "mouse";
                const isTouchpad = dev.class === "touchpad";

                let isGrabbed = dev.grabbed;
                if (grabs) {
                  if (isKeyboard) {
                    isGrabbed =
                      grabs.grabAllKeyboards || listMatchesDevice(grabs.grabKeyboards, dev);
                  } else if (isMouse) {
                    isGrabbed = grabs.grabAllMice || listMatchesDevice(grabs.grabMice, dev);
                  } else if (isTouchpad) {
                    // Mirrors the daemon: touchpads need an explicit selector.
                    isGrabbed = listMatchesDevice(grabs.grabMice, dev);
                  }
                }

                const canToggle = isKeyboard || isMouse || isTouchpad;
                const err = deviceErrors[dev.name];

                return (
                  <tr key={dev.path}>
                    <td className="devices-table__name">{dev.name}</td>
                    <td className="devices-table__vid-pid">
                      {toHex(dev.vendor)}:{toHex(dev.product)}
                    </td>
                    <td>
                      <span className={`dev-badge dev-badge--${dev.class}`}>
                        {CLASS_LABELS[dev.class] ?? "Other"}
                      </span>
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
