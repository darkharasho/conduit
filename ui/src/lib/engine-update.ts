import type { SetupStatus } from "./client";

/** True only when we know the engine's version and it differs from the app's. */
export function isEngineOutdated(s: SetupStatus): boolean {
  return s.daemon_version !== null && s.daemon_version !== s.app_version;
}
