import { getCurrentWindow } from "@tauri-apps/api/window";

interface Props {
  /** Daemon connection state: true = ok, false = down, null = unknown yet */
  connected: boolean | null;
}

/**
 * Custom titlebar for the frameless window (`decorations: false`).
 *
 * The bar (and its passive labels) carry `data-tauri-drag-region`, which makes
 * them a compositor drag handle; double-click toggles maximize (handled by
 * Tauri). Window controls call the window API lazily so the component renders
 * fine outside Tauri (vitest/jsdom).
 */
export function Titlebar({ connected }: Props) {
  const win = () => getCurrentWindow();

  return (
    <div className="titlebar" data-tauri-drag-region>
      <span className="titlebar__logo" data-tauri-drag-region>
        Conduit
      </span>
      <span className="titlebar__version" data-tauri-drag-region>
        v0.1
      </span>
      <span
        className={`titlebar__daemon${connected === true ? " titlebar__daemon--ok" : ""}${
          connected === false ? " titlebar__daemon--err" : ""
        }`}
        data-tauri-drag-region
        title={
          connected === true
            ? "Daemon connected"
            : connected === false
              ? "Daemon unreachable"
              : "Connecting…"
        }
      >
        ● daemon
      </span>
      <span className="titlebar__spacer" data-tauri-drag-region />
      <button
        className="titlebar__btn"
        aria-label="Minimize"
        onClick={() => win().minimize()}
      >
        ─
      </button>
      <button
        className="titlebar__btn"
        aria-label="Maximize"
        onClick={() => win().toggleMaximize()}
      >
        ▢
      </button>
      <button
        className="titlebar__btn titlebar__btn--close"
        aria-label="Close"
        onClick={() => win().close()}
      >
        ✕
      </button>
    </div>
  );
}
