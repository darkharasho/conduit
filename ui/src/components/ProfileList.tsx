import { useState } from "react";
import type { ConfigModel } from "../lib/config-model";
import { listProfiles, addProfile } from "../lib/config-model";
import { listWindows } from "../lib/client";
import type { FocusInfo } from "../lib/client";

interface Props {
  model: ConfigModel;
  activeProfile: string;
  onSelectProfile: (name: string) => void;
  onModelChange: (model: ConfigModel) => void;
}

export function ProfileList({
  model,
  activeProfile,
  onSelectProfile,
  onModelChange,
}: Props) {
  const [showModal, setShowModal] = useState(false);
  const [windows, setWindows] = useState<FocusInfo[]>([]);
  const [loadingWindows, setLoadingWindows] = useState(false);
  const [windowError, setWindowError] = useState<string | null>(null);

  const profiles = listProfiles(model);

  const openModal = async () => {
    setShowModal(true);
    setLoadingWindows(true);
    setWindowError(null);
    try {
      const wins = await listWindows();
      setWindows(wins);
    } catch (err) {
      setWindowError(String(err));
    } finally {
      setLoadingWindows(false);
    }
  };

  const handleSelectWindow = (win: FocusInfo) => {
    const name = win.class.toLowerCase().replace(/\s+/g, "_");
    const updated = addProfile(model, name, win.class);
    onModelChange(updated);
    onSelectProfile(name);
    setShowModal(false);
  };

  return (
    <div className="profile-list">
      <div className="profile-list__header">Profiles</div>
      <ul className="profile-list__items">
        {profiles.map((name) => (
          <li key={name}>
            <button
              className={`profile-list__item${
                name === activeProfile ? " profile-list__item--active" : ""
              }`}
              onClick={() => onSelectProfile(name)}
            >
              {name}
            </button>
          </li>
        ))}
      </ul>
      <button className="profile-list__add btn btn--secondary" onClick={openModal}>
        + New profile
      </button>

      {showModal && (
        <div className="modal-backdrop" onClick={() => setShowModal(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Select window for new profile"
          >
            <div className="modal__header">
              <span>Select window class</span>
              <button
                className="modal__close"
                onClick={() => setShowModal(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="modal__body">
              {loadingWindows && (
                <div className="muted">Loading windows…</div>
              )}
              {windowError && (
                <div className="action-error">{windowError}</div>
              )}
              {!loadingWindows && windows.length === 0 && !windowError && (
                <div className="muted">No windows found.</div>
              )}
              <ul className="window-list">
                {windows.map((win, idx) => (
                  <li key={idx}>
                    <button
                      className="window-list__item"
                      onClick={() => handleSelectWindow(win)}
                    >
                      <span className="window-list__class">{win.class}</span>
                      <span className="window-list__title muted"> — {win.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
