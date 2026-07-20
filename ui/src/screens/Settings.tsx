import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import type { SetupStatus } from "../lib/client";
import { setupStatus, setupInstallService, ConduitError } from "../lib/client";
import { presentError } from "../lib/error-messages";
import { isEngineOutdated } from "../lib/engine-update";

export function SettingsScreen() {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    isEnabled()
      .then(setEnabled)
      .catch(() => setError("Couldn't read the startup setting."));
  }, []);

  const recheckEngine = async () => {
    try {
      const s = await setupStatus();
      setStatus(s);
    } catch {
      // silently ignore — the row just won't show/update
    }
  };

  useEffect(() => {
    recheckEngine();
  }, []);

  async function toggle() {
    setError(null);
    try {
      if (enabled) {
        await disable();
      } else {
        await enable();
      }
      setEnabled(await isEnabled());
    } catch {
      setError("Couldn't change the startup setting.");
    }
  }

  async function handleUpdateEngine() {
    setUpdating(true);
    setUpdateError(null);
    try {
      await setupInstallService();
    } catch (err) {
      setUpdateError(presentError(err as ConduitError).title);
      setUpdating(false);
      return;
    }
    await recheckEngine();
    setUpdating(false);
  }

  return (
    <div className="settings">
      <h1 className="settings__title">Settings</h1>
      <div className="settings__row">
        <div className="settings__row-text">
          <div className="settings__row-label">Open on startup</div>
          <div className="settings__row-desc">
            Launch Conduit in the tray when you log in.
          </div>
        </div>
        <button
          className="app-strip__switch"
          role="switch"
          aria-checked={enabled}
          aria-label="Open on startup"
          onClick={toggle}
        >
          {enabled ? "On" : "Off"}
        </button>
      </div>
      {status && isEngineOutdated(status) && (
        <div className="settings__row">
          <div className="settings__row-text">
            <div className="settings__row-label">Engine update available</div>
            <div className="settings__row-desc">
              A newer engine version is ready to install.
            </div>
          </div>
          <button
            className="btn"
            disabled={updating}
            onClick={handleUpdateEngine}
          >
            {updating ? "Updating…" : "Update now"}
          </button>
        </div>
      )}
      {updateError && (
        <div className="home__error" role="alert">
          <div className="home__error-title">{updateError}</div>
        </div>
      )}
      {error && (
        <div className="home__error" role="alert">
          <div className="home__error-title">{error}</div>
        </div>
      )}
    </div>
  );
}
