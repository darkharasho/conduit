import type { AppPill } from "../lib/app-registry";

interface AppPillsBarProps {
  pills: AppPill[];
  active: string; // profileName
  onSelect: (profileName: string) => void;
  onAdd: () => void; // opens the picker
}

export function AppPillsBar({ pills, active, onSelect, onAdd }: AppPillsBarProps) {
  return (
    <div className="app-pills" role="tablist">
      <span className="app-pills__label">Buttons work like this</span>
      {pills.map((pill) => {
        const isActive = pill.profileName === active;
        const isPaused = !pill.autoSwitch;
        return (
          <button
            key={pill.profileName}
            role="tab"
            aria-selected={isActive}
            className={`app-pill${isActive ? " app-pill--active" : ""}${isPaused ? " app-pill--paused" : ""}`}
            onClick={() => onSelect(pill.profileName)}
            title={isPaused ? "Switch automatically is off" : undefined}
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
      <button className="app-pill app-pill--add" onClick={onAdd}>
        + In an app…
      </button>
    </div>
  );
}
