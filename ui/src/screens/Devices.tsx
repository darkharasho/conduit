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

function toHex(n: number): string {
  return n.toString(16).padStart(4, "0");
}

export function DevicesScreen() {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [config, setConfigModel] = useState<ConfigModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deviceErrors, setDeviceErrors] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState<boolean | null>(null);

  // Pending keyboard toggle confirmation dialog state
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

    // Refetch on every status push (hotplug liveness)
    const unlistenStatus = onStatus(() => {
      fetchAll();
    });

    const unlistenConn = onConnection((c) => {
      setConnected(c);
      if (c) fetchAll();
    });

    return () => {
      unlistenStatus.then((fn) => fn());
      unlistenConn.then(([fn1, fn2]) => {
        fn1();
        fn2();
      });
    };
  }, []);

  const clearDeviceError = (name: string) => {
    setDeviceErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const setDeviceError = (name: string, msg: string) => {
    setDeviceErrors((prev) => ({ ...prev, [name]: msg }));
  };

  const applyConfig = async (newModel: ConfigModel) => {
    const toml = serializeConfigToml(newModel);
    await setConfig(toml);
    setConfigModel(newModel);
  };

  // Called after user confirms the keyboard grab toggle
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

    // Determine currently-grabbed keyboards from the device list
    const currentlyGrabbed = devices
      .filter((d) => d.is_keyboard && d.grabbed)
      .map((d) => d.name);

    if (grabs.grabAllKeyboards && !newGrabbed) {
      // Show confirm dialog about grab_all→explicit-list conversion
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

  const cancelGrabAllConversion = () => {
    setPendingKbToggle(null);
  };

  const grabs = config ? getDeviceGrabs(config) : null;

  return (
    <div className="screen devices-screen">
      {connected === false && (
        <div className="banner banner--error" role="alert">
          Daemon unreachable — device list may be stale
        </div>
      )}

      <h2 className="screen__title">Devices</h2>

      {loadError && (
        <div className="banner banner--error" role="alert">
          Failed to load devices: {loadError}
        </div>
      )}

      {/* Confirm dialog for grab_all → explicit list conversion */}
      {pendingKbToggle && (
        <div className="dialog-overlay" role="dialog" aria-modal="true">
          <div className="dialog">
            <h3 className="dialog__title">Change keyboard grab mode</h3>
            <p className="dialog__body">
              Currently, <strong>all keyboards</strong> are grabbed
              automatically (<code>grab_all_keyboards = true</code>).
            </p>
            <p className="dialog__body">
              Ungrabbing <strong>{pendingKbToggle.device.name}</strong> will
              switch to an explicit list of keyboards. Only the currently-grabbed
              keyboards (minus this one) will be grabbed going forward. New
              keyboards added later will <em>not</em> be grabbed automatically.
            </p>
            <p className="dialog__body">
              Currently grabbed keyboards that will remain grabbed:
            </p>
            <ul className="dialog__list">
              {pendingKbToggle.currentlyGrabbed
                .filter((n) => n !== pendingKbToggle.device.name)
                .map((n) => (
                  <li key={n}>{n}</li>
                ))}
            </ul>
            <div className="dialog__actions">
              <button className="btn btn--primary" onClick={confirmGrabAllConversion}>
                Switch to explicit list
              </button>
              <button className="btn btn--secondary" onClick={cancelGrabAllConversion}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {grabs?.grabAllKeyboards && (
        <div className="banner banner--info">
          All keyboards are grabbed automatically (<code>grab_all_keyboards = true</code>).
          Uncheck a keyboard below to switch to an explicit list.
        </div>
      )}

      {devices.length === 0 && !loadError ? (
        <p className="muted">No devices found.</p>
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

              // Determine grabbed state from config (authoritative) or device info
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
                <tr key={dev.path} className={`devices-table__row ${isGrabbed ? "devices-table__row--grabbed" : ""}`}>
                  <td className="devices-table__name">{dev.name}</td>
                  <td className="devices-table__vid-pid">
                    <code>
                      {toHex(dev.vendor)}:{toHex(dev.product)}
                    </code>
                  </td>
                  <td className="devices-table__types">
                    {isKeyboard && (
                      <span className="badge badge--keyboard">Keyboard</span>
                    )}
                    {isMouse && (
                      <span className="badge badge--mouse">Mouse</span>
                    )}
                    {!isKeyboard && !isMouse && (
                      <span className="badge badge--other muted">Other</span>
                    )}
                  </td>
                  <td className="devices-table__grab">
                    {canToggle ? (
                      <label className="grab-toggle" title={isGrabbed ? "Click to ungrab" : "Click to grab"}>
                        <input
                          type="checkbox"
                          checked={isGrabbed}
                          onChange={(e) => {
                            if (isKeyboard) {
                              handleKeyboardToggle(dev, e.target.checked);
                            } else {
                              handleMouseToggle(dev, e.target.checked);
                            }
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
                      <div className="devices-table__error" role="alert">
                        {err}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
