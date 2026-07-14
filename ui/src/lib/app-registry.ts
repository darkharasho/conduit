import type { ConfigModel } from "./config-model";
import { getProfileMatchLabel } from "./config-model";
import type { InstalledApp } from "./client";

export interface AppPill {
  profileName: string;
  label: string;                 // "Everywhere" | app display name | match label for advanced
  kind: "everywhere" | "app" | "advanced";
  matchClass: string | null;
  autoSwitch: boolean;           // always true for everywhere
  icon: string | null;           // data URI when an installed app matched
  isBrowser: boolean;
}

/**
 * Derives app pills from a config model and installed apps list.
 *
 * - default profile first as kind "everywhere", label "Everywhere"
 * - class-matched profiles → kind "app": label = matched InstalledApp.name ?? capitalized class; icon from match
 * - profiles matching only process/title → kind "advanced": label = getProfileMatchLabel value
 */
export function appPills(model: ConfigModel, installed: InstalledApp[]): AppPill[] {
  const pills: AppPill[] = [];

  // Find default profile
  const defaultProfile = model.profiles.find((p) => p.name === "default");

  if (defaultProfile) {
    pills.push({
      profileName: "default",
      label: "Everywhere",
      kind: "everywhere",
      matchClass: null,
      autoSwitch: true,
      icon: null,
      isBrowser: false,
    });
  }

  // Process non-default profiles
  for (const profile of model.profiles) {
    if (profile.name === "default") continue;

    const matchClass = profile.match?.class;

    if (matchClass) {
      // Class-matched profile → kind "app"
      const matchedApp = matchInstalledApp(matchClass, installed);
      const label = matchedApp?.name ?? capitalize(matchClass);
      const icon = matchedApp?.icon ?? null;
      const isBrowser = matchedApp?.categories.includes("WebBrowser") ?? false;

      pills.push({
        profileName: profile.name,
        label,
        kind: "app",
        matchClass,
        autoSwitch: profile.autoSwitch ?? true,
        icon,
        isBrowser,
      });
    } else {
      // No class match → kind "advanced"
      const matchLabel = getProfileMatchLabel(model, profile.name);

      pills.push({
        profileName: profile.name,
        label: matchLabel ?? profile.name,
        kind: "advanced",
        matchClass: null,
        autoSwitch: profile.autoSwitch ?? true,
        icon: null,
        isBrowser: false,
      });
    }
  }

  return pills;
}

/**
 * Matches an installed app by window class.
 *
 * Case-insensitive, in order:
 * 1. wm_class === cls
 * 2. app_id === cls
 * 3. app_id endsWith("." + cls)
 * 4. name === cls
 */
export function matchInstalledApp(cls: string, installed: InstalledApp[]): InstalledApp | null {
  const clsLower = cls.toLowerCase();

  // Try exact wm_class match
  for (const app of installed) {
    if (app.wm_class?.toLowerCase() === clsLower) {
      return app;
    }
  }

  // Try exact app_id match
  for (const app of installed) {
    if (app.app_id.toLowerCase() === clsLower) {
      return app;
    }
  }

  // Try app_id ends with reverse-dns suffix
  for (const app of installed) {
    if (app.app_id.toLowerCase().endsWith("." + clsLower)) {
      return app;
    }
  }

  // Try exact name match
  for (const app of installed) {
    if (app.name.toLowerCase() === clsLower) {
      return app;
    }
  }

  return null;
}

/**
 * Helper: capitalize first letter of a string
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
