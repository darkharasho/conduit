import { describe, expect, it } from "vitest";
import type { InstalledApp } from "./client";
import { parseConfigToml } from "./config-model";
import { appPills, matchInstalledApp } from "./app-registry";

const APPS: InstalledApp[] = [
  { app_id: "org.mozilla.firefox", name: "Firefox", wm_class: "firefox", categories: ["Network", "WebBrowser"], icon: "data:image/png;base64,AAA" },
  { app_id: "steam", name: "Steam", wm_class: null, categories: ["Game"], icon: null },
];

const TOML = `
[profile.default.keys]
a = "b"
[profile.firefox]
match = { class = "firefox" }
auto_switch = false
[profile.firefox.keys]
f1 = "back"
[profile.notes]
match = { title = ".*TODO.*" }
[profile.notes.keys]
f2 = "esc"
`;

describe("app-registry", () => {
  it("derives pills: Everywhere first, app pills with names/icons, advanced for non-class", () => {
    const pills = appPills(parseConfigToml(TOML), APPS);
    expect(pills[0]).toMatchObject({ kind: "everywhere", label: "Everywhere", profileName: "default" });
    const ff = pills.find((p) => p.profileName === "firefox")!;
    expect(ff).toMatchObject({ kind: "app", label: "Firefox", autoSwitch: false, isBrowser: true });
    expect(ff.icon).toContain("data:image/png");
    expect(pills.find((p) => p.profileName === "notes")!.kind).toBe("advanced");
  });

  it("matches installed apps by wm_class, id, reverse-dns suffix, and name", () => {
    expect(matchInstalledApp("firefox", APPS)?.name).toBe("Firefox");
    expect(matchInstalledApp("Firefox", APPS)?.name).toBe("Firefox");
    expect(matchInstalledApp("steam", APPS)?.name).toBe("Steam");
    expect(matchInstalledApp("unknown", APPS)).toBeNull();
  });
});
