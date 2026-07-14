import { useEffect, useState } from "react";
import type { AppPill } from "../lib/app-registry";

interface AppContextStripProps {
  pill: AppPill;
  onToggleAutoSwitch: (on: boolean) => void;
  onRemove: () => void;
}

export function AppContextStrip({ pill, onToggleAutoSwitch, onRemove }: AppContextStripProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Close menu on Escape or click outside.
  useEffect(() => {
    if (!menuOpen) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMenuOpen(false);
      }
    }

    function onMouseDown(e: MouseEvent) {
      // Close if the click target is outside the menu button/list area.
      // We use document mousedown so any outside click dismisses the menu.
      void e;
      setMenuOpen(false);
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [menuOpen]);

  return (
    <div className="app-strip">
      <p className="app-strip__desc">
        When {pill.label} is the window you&apos;re using, the highlighted buttons change.
        Everything else keeps its Everywhere setting.
      </p>
      <div className="app-strip__controls">
        <button
          className="app-strip__switch"
          role="switch"
          aria-checked={pill.autoSwitch}
          onClick={() => onToggleAutoSwitch(!pill.autoSwitch)}
        >
          Switch automatically
        </button>
        <div className="app-strip__menu">
          <button
            className="app-strip__menu-btn"
            aria-label="More options"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
              setConfirming(false);
            }}
          >
            ⋯
          </button>
          {menuOpen && !confirming && (
            <div
              className="app-strip__menu-list"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                className="app-strip__menu-item"
                onClick={() => {
                  setConfirming(true);
                  setMenuOpen(false);
                }}
              >
                Remove {pill.label} settings
              </button>
            </div>
          )}
        </div>
      </div>
      {confirming && (
        <div className="app-strip__confirm">
          <p>
            Buttons will use their Everywhere settings in {pill.label}. This can&apos;t be undone.
          </p>
          <div className="app-strip__confirm-btns">
            <button className="btn--danger" onClick={onRemove}>
              Remove
            </button>
            <button className="btn--ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
