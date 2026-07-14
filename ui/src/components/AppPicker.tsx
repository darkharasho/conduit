import { useEffect, useState } from "react";
import { listWindows, listInstalledApps } from "../lib/client";
import type { FocusInfo, InstalledApp } from "../lib/client";
import type { ConfigModel } from "../lib/config-model";
import { matchInstalledApp } from "../lib/app-registry";

interface AppPickerProps {
  model: ConfigModel;
  onPick: (name: string, matchClass: string) => void;
  /** Called when the user creates an advanced (non-class) match rule. */
  onPickAdvanced?: (name: string, match: Record<string, string>) => void;
  onClose: () => void;
}

/**
 * Deduplicate windows by class, returning only one entry per class.
 */
function dedupeByClass(wins: FocusInfo[]): FocusInfo[] {
  const seen = new Set<string>();
  return wins.filter((w) => {
    if (seen.has(w.class)) return false;
    seen.add(w.class);
    return true;
  });
}

/**
 * Return the set of window classes that already have a pill (profile with class match).
 */
function existingClasses(model: ConfigModel): Set<string> {
  const classes = new Set<string>();
  for (const profile of model.profiles) {
    if (profile.match?.class) {
      classes.add(profile.match.class.toLowerCase());
    }
  }
  return classes;
}

export function AppPicker({ model, onPick, onPickAdvanced, onClose }: AppPickerProps) {
  const [windows, setWindows] = useState<FocusInfo[]>([]);
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [advName, setAdvName] = useState("Custom rule");
  const [advClass, setAdvClass] = useState("");
  const [advProcess, setAdvProcess] = useState("");
  const [advTitle, setAdvTitle] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([listWindows(), listInstalledApps()])
      .then(([wins, apps]) => {
        if (!cancelled) {
          setWindows(wins);
          setInstalled(apps);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const taken = existingClasses(model);

  // "Open now": dedupe by class, exclude classes that already have a pill
  const openNow = dedupeByClass(windows).filter(
    (w) => !taken.has(w.class.toLowerCase())
  );

  // Filter by search query
  const query = search.toLowerCase();
  const filteredOpen = query
    ? openNow.filter(
        (w) =>
          w.class.toLowerCase().includes(query) ||
          w.process.toLowerCase().includes(query) ||
          w.title.toLowerCase().includes(query)
      )
    : openNow;

  const filteredInstalled = installed.filter((app) => {
    // Exclude apps whose pick class already has a pill
    const pickClass = (app.wm_class ?? app.app_id).toLowerCase();
    if (taken.has(pickClass)) return false;
    if (query && !app.name.toLowerCase().includes(query) && !app.app_id.toLowerCase().includes(query)) {
      return false;
    }
    return true;
  });

  function windowDisplayName(win: FocusInfo): string {
    return matchInstalledApp(win.class, installed)?.name ?? win.class;
  }

  function handleWindowPick(win: FocusInfo) {
    const matchedApp = matchInstalledApp(win.class, installed);
    const name = matchedApp?.name ?? win.class;
    onPick(name, win.class);
  }

  function handleInstalledPick(app: InstalledApp) {
    const matchClass = app.wm_class ?? app.app_id;
    onPick(app.name, matchClass);
  }

  function handleAdvancedCreate() {
    if (!onPickAdvanced) return;
    const match: Record<string, string> = {};
    if (advClass.trim()) match.class = advClass.trim();
    if (advProcess.trim()) match.process = advProcess.trim();
    if (advTitle.trim()) match.title = advTitle.trim();
    onPickAdvanced(advName.trim() || "Custom rule", match);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal app-picker"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add an app"
      >
        <div className="modal__header">
          <span>In an app…</span>
          <button className="modal__close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="modal__body">
          {advancedMode ? (
            <div className="app-picker__advanced">
              <div className="app-picker__adv-field">
                <label className="app-picker__adv-label" htmlFor="adv-name">Name</label>
                <input
                  id="adv-name"
                  type="text"
                  className="app-picker__adv-input"
                  value={advName}
                  onChange={(e) => setAdvName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="app-picker__adv-field">
                <label className="app-picker__adv-label" htmlFor="adv-class">Class</label>
                <input
                  id="adv-class"
                  type="text"
                  className="app-picker__adv-input"
                  value={advClass}
                  onChange={(e) => setAdvClass(e.target.value)}
                  placeholder="e.g. firefox"
                />
              </div>
              <div className="app-picker__adv-field">
                <label className="app-picker__adv-label" htmlFor="adv-process">Process</label>
                <input
                  id="adv-process"
                  type="text"
                  className="app-picker__adv-input"
                  value={advProcess}
                  onChange={(e) => setAdvProcess(e.target.value)}
                  placeholder="e.g. firefox"
                />
              </div>
              <div className="app-picker__adv-field">
                <label className="app-picker__adv-label" htmlFor="adv-title">Title pattern</label>
                <input
                  id="adv-title"
                  type="text"
                  className="app-picker__adv-input"
                  value={advTitle}
                  onChange={(e) => setAdvTitle(e.target.value)}
                  placeholder="e.g. GitHub"
                />
              </div>
              <div className="app-picker__adv-actions">
                <button className="btn btn--primary" onClick={handleAdvancedCreate}>
                  Create
                </button>
                <button className="btn btn--ghost" onClick={() => setAdvancedMode(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="app-picker__search">
                <input
                  type="search"
                  placeholder="Search apps…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  autoFocus
                />
              </div>

              {loading && <div className="muted">Looking at your open apps…</div>}

              {!loading && filteredOpen.length > 0 && (
                <div className="app-picker__section">
                  <div className="app-picker__section-label">Open now</div>
                  {filteredOpen.map((win) => {
                    const displayName = windowDisplayName(win);
                    return (
                      <button
                        key={win.class}
                        className="app-picker__row"
                        onClick={() => handleWindowPick(win)}
                        title={win.title}
                      >
                        <span className="app-pill__avatar">{displayName.charAt(0).toUpperCase()}</span>
                        <span className="app-picker__row-name">{displayName}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {!loading && filteredInstalled.length > 0 && (
                <div className="app-picker__section">
                  <div className="app-picker__section-label">Installed</div>
                  {filteredInstalled.map((app) => (
                    <button
                      key={app.app_id}
                      className="app-picker__row"
                      onClick={() => handleInstalledPick(app)}
                    >
                      {app.icon ? (
                        <img className="app-pill__avatar" src={app.icon} alt="" aria-hidden="true" />
                      ) : (
                        <span className="app-pill__avatar">{app.name.charAt(0)}</span>
                      )}
                      <span className="app-picker__row-name">{app.name}</span>
                    </button>
                  ))}
                </div>
              )}

              {!loading && filteredOpen.length === 0 && filteredInstalled.length === 0 && (
                <div className="muted">No apps found.</div>
              )}

              {onPickAdvanced && (
                <button
                  className="app-picker__adv-link"
                  onClick={() => setAdvancedMode(true)}
                >
                  Advanced: match a specific window…
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
