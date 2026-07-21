import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface AppUpdate {
  /** Version offered by the release feed, e.g. "0.3.0". */
  version: string;
  /** Download, verify, install the new AppImage, then relaunch. */
  install: () => Promise<void>;
}

/**
 * Check the release feed for a newer app version.
 *
 * Resolves null when up to date — and also on any failure (offline, feed
 * missing, running outside a bundled AppImage in dev), so callers can treat
 * "no update" and "can't check" the same quiet way.
 */
export async function checkForAppUpdate(): Promise<AppUpdate | null> {
  try {
    const update: Update | null = await check();
    if (!update) return null;
    return {
      version: update.version,
      install: async () => {
        await update.downloadAndInstall();
        await relaunch();
      },
    };
  } catch {
    return null;
  }
}
