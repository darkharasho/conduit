# Experience Redesign Phase 4: Per-App Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-app behavior per spec Section 4 — app pills on the editor ("Buttons work like this: Everywhere / Firefox / + In an app…"), an overlay model with visible inheritance, a non-destructive "Switch automatically" toggle, and an app picker built on desktop entries with real names and icons — with the word "profile" retired from rendered UI.

**Architecture:** The core gains an `auto_switch` profile flag (default true; `set_focus` skips non-switching profiles — a stripped matcher would ALWAYS match, so skipping is the only correct mechanism). The Tauri shell gains a filesystem-local `list_installed_apps` command that parses `.desktop` entries and resolves icons to data URIs. A new `app-registry.ts` derives pills from profiles and matches KWin resource classes to installed apps. Mappings absorbs profile selection (pills bar + picker); the App rail's profiles section and modal are deleted. Visible inheritance comes from one new config-model lookup (`actionWithEverywhereFallback`) threaded through the existing viz components as dimmed "inherited" rendering.

**Tech Stack:** Rust (conduit-core, Tauri shell + `base64` crate), React + TypeScript (vitest, `fireEvent`).

## Global Constraints

- Before any `cargo` command: `export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig`.
- Vitest cap 2 (config-enforced); `npx vitest run` from `ui/`; `npx tsc --noEmit` stays clean.
- TOML: the flag is `auto_switch = false` under `[profile.<name>]` (absent = true). Serialization must round-trip it.
- Jargon ban extends: new rendered copy must not contain "daemon", "socket", raw hex, `key:N`, **or "profile"** (the word is retired in user-facing text this phase; existing screens' copy outside the touched surfaces stays until Phase 6).
- Spec copy verbatim: pills label "Buttons work like this"; default pill "Everywhere"; add pill "+ In an app…"; context strip "When {App} is the window you're using, the highlighted buttons change. Everything else keeps its Everywhere setting."; toggle label "Switch automatically"; assign-panel eyebrow "In {App}"; footer hatch "Use the Everywhere setting ({label})"; picker advanced link "Advanced: match a specific window…"; remove action "Remove {App} settings" with confirm body "Buttons will use their Everywhere settings in {App}. This can't be undone."
- Desktop-entry dirs, in this order: `/usr/share/applications`, `$HOME/.local/share/applications`, `/var/lib/flatpak/exports/share/applications`. Skip entries with `NoDisplay=true` or `Type` ≠ `Application`. Icons: absolute path → read directly; theme name → try `/usr/share/icons/hicolor/{128x128,64x64,48x48}/apps/{name}.png` then `/usr/share/pixmaps/{name}.{png,svg}`; unresolvable → null (UI renders a letter avatar). Never read a file larger than 512 KB.
- Every task ends green: `cargo test --workspace` and `cd ui && npx vitest run && npx tsc --noEmit` (fix-round verifications INCLUDE tsc — standing lesson).

---

### Task 1: Core — `auto_switch` flag

**Files:**
- Modify: `crates/conduit-core/src/config.rs` (RawProfile :171–198, compile :378–415, CompiledProfile struct)
- Modify: `crates/conduit-core/src/engine.rs` (`set_focus` :307–315)

**Interfaces:**
- Produces: `RawProfile.auto_switch: Option<bool>`; compiled profile carries `pub auto_switch: bool` (default true); `set_focus` skips profiles with `auto_switch == false` (they can still be reached by explicit UI selection later — engine-side that means: never auto-activated; the default profile is never skipped). `ConfigError` unchanged — `auto_switch = false` still requires a match rule (it's paused, not matchless).

- [ ] **Step 1: Write the failing tests**

config.rs tests:

```rust
    #[test]
    fn auto_switch_flag_compiles_and_defaults_true() {
        let cfg = compile(
            "[profile.default.keys]\n\n[profile.firefox]\nmatch = { class = \"firefox\" }\nauto_switch = false\n[profile.firefox.keys]\nf1 = \"back\"\n",
        )
        .unwrap();
        let ff = cfg.profiles.iter().find(|p| p.name == "firefox").unwrap();
        assert!(!ff.auto_switch);
        let def = cfg.profiles.iter().find(|p| p.name == "default").unwrap();
        assert!(def.auto_switch);
    }
```

engine.rs tests:

```rust
    #[test]
    fn paused_profile_is_never_auto_selected() {
        let mut e = engine(
            "[profile.default.keys]\na = \"b\"\n\n[profile.game]\nmatch = { class = \"steam_app_123\" }\nauto_switch = false\n[profile.game.keys]\na = \"x\"\n",
        );
        e.set_focus(&focus("steam_app_123"));
        // Focus matches game's rule, but switching is paused: default stays live.
        assert_eq!(e.handle(press("a", 0)), &[press("b", 0)]);
    }
```

(Reuse the file's existing `engine`/`focus`/`press` helpers; if compiled profiles expose no public `name`/`auto_switch`, add the field alongside however `matcher` is exposed today and mirror that visibility.)

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p conduit-core auto_switch paused_profile`
Expected: compile error — unknown field.

- [ ] **Step 3: Implement**

- `RawProfile` gains `#[serde(default)] auto_switch: Option<bool>,` (accepting `auto_switch = false`).
- The compiled profile struct gains `pub auto_switch: bool,` set from `raw.auto_switch.unwrap_or(true)` at the compile site (:378–415).
- `set_focus` (:307–315): in the first-match-wins loop, skip candidates with `!p.auto_switch` (the default/fallback entry is reached exactly as today because its `matcher` is `None` and its `auto_switch` is true).

- [ ] **Step 4: Full core + daemon suites**

Run: `cargo test -p conduit-core -p conduit-daemon`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/conduit-core/src/config.rs crates/conduit-core/src/engine.rs
git commit -m "feat(core): auto_switch profile flag — paused apps never auto-activate"
```

---

### Task 2: config-model — autoSwitch, removeProfile, Everywhere fallback

**Files:**
- Modify: `ui/src/lib/config-model.ts` (ProfileModel :28–41, parse/serialize, new helpers)
- Test: `ui/src/lib/config-model.test.ts` (append)

**Interfaces:**
- Produces (Tasks 4–6 rely on):

```typescript
// ProfileModel gains: autoSwitch?: boolean;   // absent/undefined = true
export function setProfileAutoSwitch(m: ConfigModel, profileName: string, on: boolean): ConfigModel; // true removes the key from TOML
export function removeProfile(m: ConfigModel, profileName: string): ConfigModel;  // throws on "default"
export function actionWithEverywhereFallback(
  m: ConfigModel, profileName: string, dev: DeviceIdent | null, layer: string, keyName: string,
): { action: ActionModel; source: "app" | "everywhere" } | null;
// profileName === "default" → wraps getEffectiveAction with source "everywhere".
// Otherwise: the app profile's own effective action (device section first) → source "app";
// else the DEFAULT profile's effective action → source "everywhere"; else null.
```

- [ ] **Step 1: Write the failing tests**

```typescript
describe("per-app helpers", () => {
  const TOML = `
[profile.default.keys]
mouse4 = "leftctrl+c"

[profile.firefox]
match = { class = "firefox" }
auto_switch = false
[profile.firefox.keys]
mouse4 = "back"
`;
  const m = parseConfigToml(TOML);

  it("round-trips auto_switch and setProfileAutoSwitch toggles it", () => {
    expect(m.profiles.find((p) => p.name === "firefox")?.autoSwitch).toBe(false);
    const on = setProfileAutoSwitch(m, "firefox", true);
    expect(serializeConfigToml(on)).not.toContain("auto_switch");
    const off = setProfileAutoSwitch(on, "firefox", false);
    expect(serializeConfigToml(off)).toContain("auto_switch = false");
  });

  it("removeProfile deletes the section and refuses default", () => {
    const removed = removeProfile(m, "firefox");
    expect(removed.profiles.map((p) => p.name)).toEqual(["default"]);
    expect(serializeConfigToml(removed)).not.toContain("firefox");
    expect(() => removeProfile(m, "default")).toThrow();
  });

  it("actionWithEverywhereFallback distinguishes overrides from inheritance", () => {
    expect(actionWithEverywhereFallback(m, "firefox", null, "base", "mouse4"))
      .toEqual({ action: { kind: "key", key: "back" }, source: "app" });
    expect(actionWithEverywhereFallback(m, "firefox", null, "base", "mouse5")).toBeNull();
    const withDefault = actionWithEverywhereFallback(m, "firefox", null, "base", "mouse4");
    expect(withDefault?.source).toBe("app");
    // Unmapped in app, mapped in default → everywhere
    const m2 = parseConfigToml(TOML.replace('mouse4 = "back"', 'mouse5 = "back"'));
    expect(actionWithEverywhereFallback(m2, "firefox", null, "base", "mouse4"))
      .toEqual({ action: { kind: "chord", keys: ["leftctrl", "c"] }, source: "everywhere" });
  });
});
```

- [ ] **Step 2: Run to verify failure** — `cd ui && npx vitest run src/lib/config-model.test.ts` → FAIL (helpers missing).

- [ ] **Step 3: Implement** — `autoSwitch` parsed from the profile table's `auto_switch` key and serialized back only when `false` (mirror how `inherit` is handled at parse/serialize sites). `setProfileAutoSwitch`: immutable clone (mirror `setProfileMatch` at :677–690); `on === true` deletes the key. `removeProfile`: immutable, filters the profile out of `profiles` and deletes its table from `_raw`; `if (profileName === "default") throw new Error("the Everywhere settings cannot be removed");`. `actionWithEverywhereFallback`: compose two `getEffectiveAction` calls per the Interfaces block.

- [ ] **Step 4: Run** — `cd ui && npx vitest run && npx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/config-model.ts ui/src/lib/config-model.test.ts
git commit -m "feat(ui): autoSwitch, removeProfile, and Everywhere-fallback lookup"
```

---

### Task 3: Tauri — `list_installed_apps`

**Files:**
- Modify: `ui/src-tauri/src/lib.rs` (new command + `generate_handler!` at :395–405)
- Create: `ui/src-tauri/src/apps.rs` (parser + icon resolution, unit-testable pure functions)
- Modify: `ui/src-tauri/Cargo.toml` (add `base64 = "0.22"`)
- Modify: `ui/src/lib/client.ts` (+ `ui/src/lib/client.test.ts` append)

**Interfaces:**
- Produces:

```rust
// apps.rs
pub struct InstalledApp {           // serde::Serialize
    pub app_id: String,             // .desktop filename stem, e.g. "org.mozilla.firefox"
    pub name: String,               // Name=
    pub wm_class: Option<String>,   // StartupWMClass=
    pub categories: Vec<String>,    // Categories= split on ';'
    pub icon: Option<String>,       // data URI (image/png base64 or image/svg+xml;utf8) or None
}
pub fn parse_desktop_entry(text: &str, stem: &str) -> Option<InstalledApp>; // None if NoDisplay/type!=Application; icon field UNRESOLVED (returns raw Icon= in `icon`)
pub fn resolve_icon(raw: &str) -> Option<String>;   // path/theme lookup per Global Constraints, 512KB cap
pub fn list_installed_apps_impl(dirs: &[std::path::PathBuf]) -> Vec<InstalledApp>; // dedup by app_id, first dir wins, sorted by name
```

```typescript
// client.ts
export interface InstalledApp { app_id: string; name: string; wm_class: string | null; categories: string[]; icon: string | null; }
export async function listInstalledApps(): Promise<InstalledApp[]>;  // invoke("list_installed_apps") through call()
```

The command `list_installed_apps` calls `list_installed_apps_impl` with the three Global-Constraints dirs (home from `std::env::var_os("HOME")`), resolving icons via `resolve_icon` after parse. Errors → `ErrorPayload::new("internal", …)`; an unreadable dir is skipped silently (partial results beat none).

- [ ] **Step 1: Write the failing Rust tests** (in `apps.rs`)

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const FIREFOX: &str = "[Desktop Entry]\nType=Application\nName=Firefox\nIcon=firefox\nStartupWMClass=firefox\nCategories=Network;WebBrowser;\n";

    #[test]
    fn parses_a_desktop_entry() {
        let app = parse_desktop_entry(FIREFOX, "org.mozilla.firefox").unwrap();
        assert_eq!(app.name, "Firefox");
        assert_eq!(app.app_id, "org.mozilla.firefox");
        assert_eq!(app.wm_class.as_deref(), Some("firefox"));
        assert!(app.categories.iter().any(|c| c == "WebBrowser"));
        assert_eq!(app.icon.as_deref(), Some("firefox")); // unresolved at parse stage
    }

    #[test]
    fn skips_nodisplay_and_non_applications() {
        assert!(parse_desktop_entry("[Desktop Entry]\nType=Application\nName=X\nNoDisplay=true\n", "x").is_none());
        assert!(parse_desktop_entry("[Desktop Entry]\nType=Link\nName=X\n", "x").is_none());
    }

    #[test]
    fn list_dedups_by_stem_first_dir_wins_and_sorts() {
        let t = std::env::temp_dir().join(format!("conduit-apps-{}", std::process::id()));
        let (a, b) = (t.join("a"), t.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("zed.desktop"), "[Desktop Entry]\nType=Application\nName=Zed A\n").unwrap();
        std::fs::write(b.join("zed.desktop"), "[Desktop Entry]\nType=Application\nName=Zed B\n").unwrap();
        std::fs::write(b.join("alpha.desktop"), "[Desktop Entry]\nType=Application\nName=Alpha\n").unwrap();
        let apps = list_installed_apps_impl(&[a, b]);
        assert_eq!(apps.iter().map(|x| x.name.as_str()).collect::<Vec<_>>(), vec!["Alpha", "Zed A"]);
        std::fs::remove_dir_all(&t).ok();
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test --manifest-path ui/src-tauri/Cargo.toml` → compile error (module missing). Note: this crate had no tests before — confirm `cargo test` picks the lib up; if the tauri lib target doesn't run unit tests directly, add `#[path]`-free plain module tests and run with `cargo test --manifest-path ui/src-tauri/Cargo.toml --lib`.

- [ ] **Step 3: Implement `apps.rs`**

Line-oriented parse of the `[Desktop Entry]` section only (stop at the next `[` header): collect `Name=`, `Icon=`, `StartupWMClass=`, `Categories=`, `NoDisplay=`, `Type=`. `resolve_icon`: if starts with `/` → read file (skip > 512 KB) and wrap: `.png` → `data:image/png;base64,{}` (base64 crate), `.svg` → `data:image/svg+xml;base64,{}`; else theme name → probe the Global-Constraints candidate paths in order, first hit read the same way. `list_installed_apps_impl`: iterate dirs in order, `read_dir` ok-else-skip, only `*.desktop`, dedup on stem via a `HashSet`, sort by `name` (case-insensitive). The `#[tauri::command] async fn list_installed_apps()` resolves icons: `app.icon = app.icon.as_deref().and_then(resolve_icon)`.

client.ts: add the interface + `listInstalledApps` through the existing `call<T>` wrapper. client.test.ts: one test mocking `invoke` resolving a two-app array, asserting passthrough.

- [ ] **Step 4: Run everything** — Rust: `cargo test --manifest-path ui/src-tauri/Cargo.toml` + `cargo build --manifest-path ui/src-tauri/Cargo.toml`; UI: `cd ui && npx vitest run && npx tsc --noEmit`. All green.

- [ ] **Step 5: Commit**

```bash
git add ui/src-tauri/src/apps.rs ui/src-tauri/src/lib.rs ui/src-tauri/Cargo.toml ui/src-tauri/Cargo.lock ui/src/lib/client.ts ui/src/lib/client.test.ts
git commit -m "feat(tauri): list_installed_apps with desktop-entry names and icons"
```

---

### Task 4: app-registry — pills and app matching

**Files:**
- Create: `ui/src/lib/app-registry.ts`
- Test: `ui/src/lib/app-registry.test.ts`

**Interfaces:**
- Consumes: `ConfigModel`/`ProfileModel` (+ `autoSwitch`), `InstalledApp` from client.
- Produces (Tasks 5–6 rely on):

```typescript
export interface AppPill {
  profileName: string;
  label: string;                 // "Everywhere" | app display name | match label for advanced
  kind: "everywhere" | "app" | "advanced";
  matchClass: string | null;
  autoSwitch: boolean;           // always true for everywhere
  icon: string | null;           // data URI when an installed app matched
  isBrowser: boolean;
}
export function appPills(model: ConfigModel, installed: InstalledApp[]): AppPill[];
// default profile first as kind "everywhere", label "Everywhere".
// class-matched profiles → kind "app": label = matched InstalledApp.name ?? capitalized class; icon from match.
// profiles matching only process/title → kind "advanced": label = getProfileMatchLabel value.
export function matchInstalledApp(cls: string, installed: InstalledApp[]): InstalledApp | null;
// case-insensitive, in order: wm_class === cls; app_id === cls; app_id endsWith("." + cls); name === cls.
```

- [ ] **Step 1: Write the failing tests**

```typescript
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
```

- [ ] **Step 2: Run to verify failure** — module missing.

- [ ] **Step 3: Implement** exactly per the Interfaces block; `isBrowser = categories.includes("WebBrowser")` on the matched app (false when unmatched); capitalized-class fallback: `cls.charAt(0).toUpperCase() + cls.slice(1)`.

- [ ] **Step 4: Run** — full UI suite + tsc → PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/app-registry.ts ui/src/lib/app-registry.test.ts
git commit -m "feat(ui): app pills derivation and installed-app matching"
```

---

### Task 5: AppPillsBar + AppPicker — selection moves into the editor

**Files:**
- Create: `ui/src/components/AppPillsBar.tsx`, `ui/src/components/AppPicker.tsx`
- Test: `ui/src/components/AppPicker.test.tsx` (create), `ui/src/App.test.tsx` (rework rail tests)
- Modify: `ui/src/screens/Mappings.tsx` (render bar; own the picker; new props), `ui/src/App.tsx` (delete rail profiles section :147–195 and the modal state/flow :41–45, :80–106; pass `onSelectProfile`), `ui/src/App.css` (append)

**Interfaces:**
- Produces:

```tsx
// AppPillsBar
interface AppPillsBarProps {
  pills: AppPill[];
  active: string;                       // profileName
  onSelect: (profileName: string) => void;
  onAdd: () => void;                    // opens the picker
}
// Renders: label "Buttons work like this" + pills (icon or letter avatar, label,
// paused badge "∅ auto" title "Switch automatically is off" when !autoSwitch) + "+ In an app…".

// AppPicker (modal)
interface AppPickerProps {
  model: ConfigModel;
  onPick: (name: string, matchClass: string) => void;   // Mappings runs addProfile + applyWithUndo
  onAdvanced: () => void;                                // reveals the match editor flow
  onClose: () => void;
}
// Content: search input; "Open now" section from listWindows() deduped by class,
// excluding classes that already have a pill; "Installed" section from listInstalledApps()
// filtered by search; rows show icon/letter-avatar + name; click → onPick(app.name, cls).
// Footer: quiet link "Advanced: match a specific window…" → onAdvanced.
```

- Mappings gains props `onSelectProfile: (name: string) => void` (App keeps `activeProfile` state; its setter is passed through). Mappings state: `pickerOpen`, `installedApps` (fetched once when the picker first opens), `advancedMatchOpen` (renders the existing `ProfileMatchEditor` flow against a new profile created with a placeholder class then edited — reuse `addProfile` + `setProfileMatch`).
- `onPick` handler in Mappings: `applyWithUndo(addProfile(model, slug(name), matchClass), `${name} added`)` where `slug` lowercases and underscores whitespace (mirror App's old logic), then `onSelectProfile(slug)`.
- App.tsx deletions: the profiles rail block and modal machinery are removed wholesale; `handleOpenAddProfile`/`handleSelectWindow`/`showProfileModal` deleted; `listWindows` import moves to AppPicker. App keeps `activeProfile`, `handleProfilesChange`, and passes `onSelectProfile={setActiveProfile}`.
- App.test.tsx: the two rail tests ("Everywhere/AUTO badge", "app picker lists open apps…") are REWRITTEN as Mappings-level tests against the pills bar and picker (same assertions in the new home: Everywhere pill present; a class with an existing pill is excluded from "Open now"). List every moved/deleted test in the commit body.

- [ ] **Step 1: Write the failing tests** (AppPicker.test.tsx)

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfigToml } from "../lib/config-model";
import { AppPicker } from "./AppPicker";

const mockListWindows = vi.fn();
const mockListInstalledApps = vi.fn();
vi.mock("../lib/client", () => ({
  listWindows: (...a: unknown[]) => mockListWindows(...a),
  listInstalledApps: (...a: unknown[]) => mockListInstalledApps(...a),
}));

const MODEL = parseConfigToml('[profile.default.keys]\n\n[profile.firefox]\nmatch = { class = "firefox" }\n[profile.firefox.keys]\nf1 = "back"\n');

beforeEach(() => {
  mockListWindows.mockResolvedValue([
    { process: "firefox", class: "firefox", title: "Mozilla Firefox" },
    { process: "steam", class: "steam", title: "Steam" },
  ]);
  mockListInstalledApps.mockResolvedValue([
    { app_id: "steam", name: "Steam", wm_class: null, categories: ["Game"], icon: null },
    { app_id: "org.kde.dolphin", name: "Dolphin", wm_class: "dolphin", categories: [], icon: null },
  ]);
});

describe("AppPicker", () => {
  it("lists open windows minus already-added apps, plus installed apps", async () => {
    render(<AppPicker model={MODEL} onPick={() => {}} onAdvanced={() => {}} onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText("Steam")).toBeInTheDocument());
    expect(screen.queryByText(/firefox/i)).toBeNull();     // already has a pill
    expect(screen.getByText("Dolphin")).toBeInTheDocument();
  });

  it("picks an app and offers the advanced link", async () => {
    const onPick = vi.fn();
    const onAdvanced = vi.fn();
    render(<AppPicker model={MODEL} onPick={onPick} onAdvanced={onAdvanced} onClose={() => {}} />);
    fireEvent.click(await screen.findByText("Dolphin"));
    expect(onPick).toHaveBeenCalledWith("Dolphin", "dolphin");
    fireEvent.click(screen.getByRole("button", { name: "Advanced: match a specific window…" }));
    expect(onAdvanced).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure** — components missing.

- [ ] **Step 3: Implement** AppPillsBar (pills row per Interfaces; letter avatar = first character of label in a `.app-pill__avatar` span), AppPicker (per Interfaces; "Open now" dedup by class; a window row's pick class is its `class`, an installed row's is `wm_class ?? app_id`), the Mappings integration, and the App.tsx deletions. CSS append: `.app-pills`, `.app-pill`, `.app-pill--active`, `.app-pill--paused`, `.app-pill__avatar`, `.app-picker` (modal overlay reusing the confirm-panel pattern), `.app-picker__section`, `.app-picker__row` — existing tokens only.

- [ ] **Step 4: Run** — full UI suite + tsc; rework App.test.tsx as specified. All green.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/AppPillsBar.tsx ui/src/components/AppPicker.tsx ui/src/components/AppPicker.test.tsx ui/src/screens/Mappings.tsx ui/src/App.tsx ui/src/App.test.tsx ui/src/App.css
git commit -m "feat(ui): app pills bar and picker replace the profile rail"
```

---

### Task 6: Overlay view — context strip, Switch automatically, visible inheritance

**Files:**
- Create: `ui/src/components/AppContextStrip.tsx` (+ test)
- Modify: `ui/src/screens/Mappings.tsx` (render strip when active pill kind ≠ everywhere; wire toggle/remove), `ui/src/components/MouseIllustration.tsx`, `ui/src/components/CuratedLayout.tsx`, `ui/src/components/MouseViz.tsx`, `ui/src/components/KeyboardViz.tsx` (inherited rendering), `ui/src/components/AssignPanel.tsx` (eyebrow + Everywhere hatch), `ui/src/App.css` (append)
- Test: `ui/src/screens/Mappings.test.tsx` (append), `ui/src/components/AssignPanel.test.tsx` (append)

**Interfaces:**
- Produces:

```tsx
// AppContextStrip
interface AppContextStripProps {
  pill: AppPill;                       // kind "app" | "advanced"
  onToggleAutoSwitch: (on: boolean) => void;   // → setProfileAutoSwitch via applyWithUndo, description `Automatic switching ${on ? "on" : "off"} for ${pill.label}`
  onRemove: () => void;                        // confirm inline, then removeProfile via applyWithUndo, description `${pill.label} settings removed`
}
// Copy verbatim: "When {label} is the window you're using, the highlighted buttons change. Everything else keeps its Everywhere setting."
// Toggle labelled "Switch automatically" (role="switch", aria-checked).
// ⋯ menu → "Remove {label} settings" → inline confirm with body
// "Buttons will use their Everywhere settings in {label}. This can't be undone." + confirm/cancel buttons.
```

- Visible inheritance: the four viz components switch their per-key lookup from `getEffectiveAction(model, activeProfile, …)` to `actionWithEverywhereFallback(model, activeProfile, …)` and add class modifiers: source "app" → existing mapped styling + new `--override` accent; source "everywhere" in a non-default profile → new `--inherited` styling (dimmed) with tooltip/callout text "Same as Everywhere". For the default profile the behavior is IDENTICAL to today (fallback helper returns source "everywhere" and no `--inherited` styling is applied when `activeProfile === "default"` — pass a boolean `overlayMode` prop or derive from the profile name inside each component; pick ONE mechanism and use it in all four).
- AssignPanel: new optional prop `appContext?: { label: string; everywhereLabel: string | null }`. When set: eyebrow line "In {label}" above the key name; the footer's first hatch becomes `Use the Everywhere setting{everywhereLabel ? ` (${everywhereLabel})` : ""}` (calls the existing `onUseDefault` — in app context Mappings passes a handler that removes the APP-profile mapping so inheritance resumes). When unset, behavior identical to today.
- Mappings passes `appContext` when active pill kind ≠ "everywhere", with `everywhereLabel = actionLabel(default profile's effective action for the key)` or null.

- [ ] **Step 1: Write the failing tests**

AppContextStrip test (new file, standard render):

```tsx
it("renders the overlay copy, switch, and guarded remove", () => {
  const onToggle = vi.fn();
  const onRemove = vi.fn();
  render(<AppContextStrip pill={{ profileName: "firefox", label: "Firefox", kind: "app", matchClass: "firefox", autoSwitch: true, icon: null, isBrowser: true }} onToggleAutoSwitch={onToggle} onRemove={onRemove} />);
  expect(screen.getByText(/When Firefox is the window you're using/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("switch", { name: "Switch automatically" }));
  expect(onToggle).toHaveBeenCalledWith(false);
  fireEvent.click(screen.getByRole("button", { name: "⋯" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Firefox settings" }));
  expect(onRemove).not.toHaveBeenCalled();  // confirm gate
  expect(screen.getByText(/Buttons will use their Everywhere settings in Firefox/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(onRemove).toHaveBeenCalled();
});
```

AssignPanel test append:

```tsx
it("shows the app eyebrow and Everywhere hatch in app context", () => {
  renderPanel({ appContext: { label: "Firefox", everywhereLabel: "Copy" } });
  expect(screen.getByText("In Firefox")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use the Everywhere setting (Copy)" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Use the button's normal behavior" })).toBeNull();
});
```

Mappings test append (inheritance rendering, follows the file's helpers): render with the two-profile TOML from Task 2, select the firefox pill, assert an element with class containing `--inherited` exists for an Everywhere-mapped key and the assign panel opened on it shows "Same as Everywhere" text in the illustration callout OR the `--inherited` marker (assert the class, not styling).

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** per the Interfaces block. CSS append: `.app-strip`, `.app-strip__switch`, `.app-strip__menu`, `--override` and `--inherited` modifiers for `.illo__marker`, `.illo__joblabel--inherited { opacity: .45; }`, `.mousekey--inherited`, `.keycap--inherited` — existing tokens only.

- [ ] **Step 4: Run** — full UI suite + tsc → PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/AppContextStrip.tsx ui/src/components/AppContextStrip.test.tsx ui/src/components/AssignPanel.tsx ui/src/components/AssignPanel.test.tsx ui/src/components/MouseIllustration.tsx ui/src/components/CuratedLayout.tsx ui/src/components/MouseViz.tsx ui/src/components/KeyboardViz.tsx ui/src/screens/Mappings.tsx ui/src/screens/Mappings.test.tsx ui/src/App.css
git commit -m "feat(ui): per-app overlay — context strip, switch toggle, visible inheritance"
```

---

### Task 7: Phase verification (coordinator)

**Files:** none expected.

- [ ] **Step 1: Full gates** — `export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig && cargo test --workspace && cargo test --manifest-path ui/src-tauri/Cargo.toml && cd ui && npx vitest run && npx tsc --noEmit`.
- [ ] **Step 2: Isolated-daemon auto_switch smoke** (no service installed; isolated pattern): start the daemon with temp `XDG_CONFIG_HOME`/`CONDUIT_SOCKET`; `set_config` a config with an `auto_switch = false` app section → expect `config_applied`; `get_status` → the paused app never appears as `active_profile` even if its class is focused (assert `active_profile == "default"`); clean up daemon + temp dir (kill by PID — env vars are not greppable in cmdline).
- [ ] **Step 3: Suggestion check** — `isBrowser` pills exist but catalog reordering was NOT in scope for Tasks 4–6; confirm the ledger notes it as the Phase 4 stretch item (AssignPanel Popular reorder when `appContext` is a browser) and either add it here as a ≤30-line follow-up commit with a test, or record explicitly as deferred with reason.

## Out of scope (later phases)

- Real per-app suggestion *ranking* beyond the browser-first Popular reorder (catalog `keywords` remain the hook).
- Explicit manual activation of a paused app's settings from the UI (engine only skips auto-switching; a "preview this app's settings" control is Phase 6 polish).
- Deleting the last remnants of "profile" wording in Help/Status screens (Phase 5/6 sweep).
- Icon-theme spec compliance (full Icon Theme Specification lookup); the pragmatic hicolor/pixmaps probe is deliberate.
