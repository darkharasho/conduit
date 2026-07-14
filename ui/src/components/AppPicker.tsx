import { useEffect, useState } from "react";
import { listWindows, listInstalledApps } from "../lib/client";
import type { FocusInfo, InstalledApp } from "../lib/client";
import type { ConfigModel } from "../lib/config-model";
import { matchInstalledApp } from "../lib/app-registry";

interface AppPickerProps {
  model: ConfigModel;
  onPick: (name: string, matchClass: string) => void;
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

export function AppPicker({ model, onPick, onClose }: AppPickerProps) {
  const [windows, setWindows] = useState<FocusInfo[]>([]);
  const [installed, setInstalled] = useState<InstalledApp[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

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
        </div>
      </div>
    </div>
  );
}
