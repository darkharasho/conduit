import { useRef } from "react";
import type { AppPill } from "../lib/app-registry";

interface AppPillsBarProps {
  pills: AppPill[];
  active: string; // profileName
  onSelect: (profileName: string) => void;
  onAdd: () => void; // opens the picker
}

export function AppPillsBar({ pills, active, onSelect, onAdd }: AppPillsBarProps) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function handleKeyDown(e: React.KeyboardEvent, index: number) {
    let next = index;
    if (e.key === "ArrowRight") {
      next = (index + 1) % pills.length;
    } else if (e.key === "ArrowLeft") {
      next = (index - 1 + pills.length) % pills.length;
    } else {
      return;
    }
    e.preventDefault();
    onSelect(pills[next].profileName);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="app-pills">
      <span className="app-pills__label">Buttons work like this</span>
      <div role="tablist" className="app-pills__list">
        {pills.map((pill, i) => {
          const isActive = pill.profileName === active;
          const isPaused = !pill.autoSwitch;
          return (
            <button
              key={pill.profileName}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={`app-pill${isActive ? " app-pill--active" : ""}${isPaused ? " app-pill--paused" : ""}`}
              ref={(el) => { tabRefs.current[i] = el; }}
              onClick={() => onSelect(pill.profileName)}
              onKeyDown={(e) => handleKeyDown(e, i)}
            >
              {pill.icon ? (
                <img className="app-pill__avatar" src={pill.icon} alt="" aria-hidden="true" />
              ) : (
                <span className="app-pill__avatar">{pill.label.charAt(0)}</span>
              )}
              <span className="app-pill__name">{pill.label}</span>
              {isPaused && (
                <span
                  className="app-pill__badge"
                  aria-label="Switch automatically is off"
                >∅ auto</span>
              )}
            </button>
          );
        })}
      </div>
      <button className="app-pill app-pill--add" onClick={onAdd}>
        + In an app…
      </button>
    </div>
  );
}
