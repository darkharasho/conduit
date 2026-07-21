import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import type { SetupStatus } from "../lib/client";
import { setupStatus, setupInstallService, ConduitError } from "../lib/client";
import { presentError } from "../lib/error-messages";
import { isEngineOutdated } from "../lib/engine-update";
import { checkForAppUpdate } from "../lib/app-update";
import type { AppUpdate } from "../lib/app-update";

export function SettingsScreen() {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [appUpdate, setAppUpdate] = useState<AppUpdate | null>(null);
  const [installingApp, setInstallingApp] = useState(false);
  const [appUpdateError, setAppUpdateError] = useState<string | null>(null);

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
    checkForAppUpdate().then(setAppUpdate);
  }, []);

  async function handleUpdateApp() {
    if (!appUpdate) return;
    setInstallingApp(true);
    setAppUpdateError(null);
    try {
      await appUpdate.install(); // relaunches on success
    } catch {
      setAppUpdateError("Couldn't install the update. Check your connection and try again.");
      setInstallingApp(false);
    }
  }

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
      {appUpdate && (
        <div className="settings__row">
          <div className="settings__row-text">
            <div className="settings__row-label">App update available</div>
            <div className="settings__row-desc">
              Conduit v{appUpdate.version} is ready to install. The app restarts
              when it finishes.
            </div>
          </div>
          <button
            className="btn btn--primary"
            disabled={installingApp}
            onClick={handleUpdateApp}
          >
            {installingApp ? "Installing…" : "Update & restart"}
          </button>
        </div>
      )}
      {appUpdateError && (
        <div className="home__error" role="alert">
          <div className="home__error-title">{appUpdateError}</div>
        </div>
      )}
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
