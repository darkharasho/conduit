import { useEffect, useState } from "react";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

export function SettingsScreen() {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    isEnabled()
      .then(setEnabled)
      .catch(() => setError("Couldn't read the startup setting."));
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
      {error && (
        <div className="home__error" role="alert">
          <div className="home__error-title">{error}</div>
        </div>
      )}
    </div>
  );
}
