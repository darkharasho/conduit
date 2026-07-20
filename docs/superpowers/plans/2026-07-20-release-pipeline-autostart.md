# Release Pipeline + Tray & Autostart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag-driven GitHub release building a Linux AppImage (UI + bundled daemon), plus tray icon, `--hidden` launch, and an "Open on startup" Settings toggle.

**Architecture:** Tauri v2 bundling with `externalBin` for `conduit-daemon`; release.yml mirrors SAI's tag→test→build→publish chain using plain steps + gh CLI; tray/autostart via Tauri built-in tray + `tauri-plugin-autostart`; new Settings view in App.tsx's view-state navigation.

**Tech Stack:** Tauri v2, tauri-plugin-autostart 2, GitHub Actions, gh CLI, node scripts (ESM), vitest, cargo test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-20-release-pipeline-autostart-design.md`
- Branch: `release-pipeline`. Commit after every task. If 1Password signing fails, use `git commit --no-gpg-sign`. **Verify `git branch --show-current` prints `release-pipeline` before AND after every commit** (subagent guardrail).
- Linux AppImage only: `bundle.targets` becomes `["appimage"]`. No signing, no updater.
- Version source of truth: `ui/src-tauri/tauri.conf.json` `.version`.
- vitest always with `--maxWorkers=2` (machine + CI convention).
- Rust: workspace warnings are CI failures — new code must be warning-free.
- UI code follows existing idioms (view-state nav in App.tsx, ErrorPayload pattern, plain CSS classes like `rail__*`).

---

### Task 1: Version bump script

**Files:**
- Create: `scripts/bump-version.mjs`
- Create: `scripts/bump-version.test.mjs`
- Modify: `package.json` (root — add `"bump": "node scripts/bump-version.mjs"` to scripts)

**Interfaces:**
- Produces: `node scripts/bump-version.mjs <semver>` rewrites the version in `ui/src-tauri/tauri.conf.json`, `ui/package.json`, `ui/src-tauri/Cargo.toml`; exported `bumpFiles(version, rootDir)` for tests; rejects non `\d+.\d+.\d+` input with exit 1.

- [ ] **Step 1: Write failing test** (`scripts/bump-version.test.mjs`, node:test) — create temp dir with minimal copies of the three files, run `bumpFiles("0.2.0", tmp)`, assert all three contain `0.2.0`; assert `bumpFiles("nope", tmp)` throws.

```js
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpFiles } from "./bump-version.mjs";

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "bump-"));
  mkdirSync(join(root, "ui/src-tauri"), { recursive: true });
  writeFileSync(join(root, "ui/src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.1.0" }, null, 2));
  writeFileSync(join(root, "ui/package.json"), JSON.stringify({ version: "0.1.0" }, null, 2));
  writeFileSync(join(root, "ui/src-tauri/Cargo.toml"), '[package]\nname = "conduit-ui"\nversion = "0.1.0"\n');
  return root;
}

test("rewrites all three files", () => {
  const root = scaffold();
  bumpFiles("0.2.0", root);
  assert.match(readFileSync(join(root, "ui/src-tauri/tauri.conf.json"), "utf8"), /"version": "0\.2\.0"/);
  assert.match(readFileSync(join(root, "ui/package.json"), "utf8"), /"version": "0\.2\.0"/);
  assert.match(readFileSync(join(root, "ui/src-tauri/Cargo.toml"), "utf8"), /^version = "0\.2\.0"$/m);
});

test("rejects non-semver", () => {
  assert.throws(() => bumpFiles("nope", scaffold()));
});
```

- [ ] **Step 2:** `node --test scripts/` → FAIL (module missing).
- [ ] **Step 3: Implement** `scripts/bump-version.mjs`:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function bumpFiles(version, rootDir) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a plain semver: ${version}`);
  const json = (rel) => {
    const p = join(rootDir, rel);
    const obj = JSON.parse(readFileSync(p, "utf8"));
    obj.version = version;
    writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  };
  json("ui/src-tauri/tauri.conf.json");
  json("ui/package.json");
  const cargoPath = join(rootDir, "ui/src-tauri/Cargo.toml");
  const cargo = readFileSync(cargoPath, "utf8")
    .replace(/^version = ".*"$/m, `version = "${version}"`);
  writeFileSync(cargoPath, cargo);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  try {
    bumpFiles(process.argv[2] ?? "", process.cwd());
    console.log(`bumped to ${process.argv[2]}`);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
```

- [ ] **Step 4:** `node --test scripts/` → PASS. Also run `node scripts/bump-version.mjs 0.1.0` from repo root (no-op rewrite) and `git diff --stat` shows only whitespace-stable files (revert if noisy).
- [ ] **Step 5:** Add root package.json script `"bump": "node scripts/bump-version.mjs"`. Commit `feat(release): version bump script syncing tauri.conf/package.json/Cargo.toml`.

### Task 2: Icon set + bundle config

**Files:**
- Create: `ui/src-tauri/icons/source.svg` (original mark)
- Create: generated `ui/src-tauri/icons/*` via `npx tauri icon`
- Modify: `ui/src-tauri/tauri.conf.json` (bundle.icon list, targets `["appimage"]`)

**Interfaces:**
- Produces: real icon files referenced by `bundle.icon`; `32x32.png` used later by tray (Task 3).

- [ ] **Step 1: Author the mark** — `ui/src-tauri/icons/source.svg`, a geometric "conduit" (two rounded vertical rails with a signal dot crossing between them), dark-slate background, cyan accent:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="224" fill="#10151c"/>
  <rect x="272" y="208" width="112" height="608" rx="56" fill="#3ec6e0"/>
  <rect x="640" y="208" width="112" height="608" rx="56" fill="#2a6f80"/>
  <circle cx="512" cy="512" r="88" fill="#e8f7fa"/>
  <rect x="384" y="484" width="256" height="56" rx="28" fill="#e8f7fa" opacity="0.55"/>
</svg>
```

- [ ] **Step 2:** Render 1024px PNG: `rsvg-convert -w 1024 -h 1024 ui/src-tauri/icons/source.svg -o /tmp/conduit-icon-1024.png` (rsvg-convert exists on this machine; fallback `inkscape` or npm `sharp` one-liner).
- [ ] **Step 3:** `cd ui && npx tauri icon /tmp/conduit-icon-1024.png` — writes sized set into `src-tauri/icons/`.
- [ ] **Step 4:** Edit tauri.conf.json bundle section:

```json
"bundle": {
  "active": true,
  "targets": ["appimage"],
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico",
    "icons/icon.png"
  ]
}
```

(Trim the list to files `tauri icon` actually produced.)
- [ ] **Step 5:** `cd ui && npm run build && cargo check -p conduit-ui` (config parse sanity). Commit `feat(ui): real icon set and appimage-only bundle target`.

### Task 3: Tray, --hidden, close-to-tray

**Files:**
- Modify: `ui/src-tauri/Cargo.toml` (tauri features `["tray-icon", "image-png"]`)
- Modify: `ui/src-tauri/tauri.conf.json` (main window `"visible": false` — shown from Rust unless `--hidden`)
- Modify: `ui/src-tauri/src/lib.rs` (tray creation in `.setup()`, window-event close intercept, show-unless-hidden)

**Interfaces:**
- Consumes: `icons/32x32.png` from Task 2.
- Produces: app keeps running with window hidden; `AppHandle`-based `show_main_window(app)` helper; `--hidden` CLI behavior for Task 4's autostart args.

- [ ] **Step 1:** Cargo.toml: `tauri = { version = "2", features = ["tray-icon", "image-png"] }`.
- [ ] **Step 2:** In `lib.rs` `.setup(|app| { ... })` add (keeping existing setup body):

```rust
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// inside .setup():
let hidden = std::env::args().any(|a| a == "--hidden");
if !hidden {
    show_main_window(&app.handle());
}
let open_item = MenuItem::with_id(app, "open", "Open Conduit", true, None::<&str>)?;
let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
let menu = Menu::with_items(app, &[&open_item, &quit_item])?;
TrayIconBuilder::with_id("main-tray")
    .icon(app.default_window_icon().cloned().expect("bundle icon set"))
    .menu(&menu)
    .show_menu_on_left_click(true)
    .on_menu_event(|app, event| match event.id.as_ref() {
        "open" => show_main_window(app),
        "quit" => app.exit(0),
        _ => {}
    })
    .build(app)?;
```

- [ ] **Step 3:** Close-to-tray — on the Builder chain add:

```rust
.on_window_event(|window, event| {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
    }
})
```

- [ ] **Step 4:** tauri.conf.json main window gets `"visible": false` (Rust shows it unless `--hidden`). Keep `"label"` default `main`.
- [ ] **Step 5:** `cargo check -p conduit-ui` clean, `cargo test --workspace` still green, and `scripts/dev.sh` manual smoke: window appears, close hides, tray Open restores, tray Quit exits. Commit `feat(ui): tray icon, close-to-tray, --hidden launch`.

### Task 4: Autostart plugin + Settings screen

**Files:**
- Modify: `ui/src-tauri/Cargo.toml` (+ `tauri-plugin-autostart = "2"`)
- Modify: `ui/src-tauri/src/lib.rs` (plugin init)
- Modify: `ui/src-tauri/capabilities/default.json` (+ autostart permissions)
- Modify: `ui/package.json` (+ `@tauri-apps/plugin-autostart`)
- Create: `ui/src/screens/Settings.tsx`
- Create: `ui/src/screens/Settings.test.tsx`
- Modify: `ui/src/App.tsx` (settings view + entry button)

**Interfaces:**
- Consumes: `--hidden` behavior from Task 3.
- Produces: `SettingsScreen` component (no props); view kind `"settings"` in App.tsx.

- [ ] **Step 1:** Rust: `tauri-plugin-autostart = "2"` in Cargo.toml; in `lib.rs` builder before `.plugin(tauri_plugin_shell::init())`:

```rust
.plugin(tauri_plugin_autostart::init(
    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
    Some(vec!["--hidden"]),
))
```

- [ ] **Step 2:** capabilities/default.json permissions += `"autostart:allow-enable"`, `"autostart:allow-disable"`, `"autostart:allow-is-enabled"`.
- [ ] **Step 3:** `cd ui && npm install @tauri-apps/plugin-autostart`.
- [ ] **Step 4: Failing component test** `ui/src/screens/Settings.test.tsx` (vitest + testing-library, mock the plugin module):

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { vi, it, expect, beforeEach } from "vitest";

const enable = vi.fn(async () => {});
const disable = vi.fn(async () => {});
let enabled = false;
vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: (...a: unknown[]) => enable(...a),
  disable: (...a: unknown[]) => disable(...a),
  isEnabled: async () => enabled,
}));

import { SettingsScreen } from "./Settings";

beforeEach(() => { enabled = false; enable.mockClear(); disable.mockClear(); });

it("reflects isEnabled on mount and toggles on", async () => {
  render(<SettingsScreen />);
  const toggle = await screen.findByRole("switch", { name: /open on startup/i });
  expect(toggle).toHaveAttribute("aria-checked", "false");
  fireEvent.click(toggle);
  await waitFor(() => expect(enable).toHaveBeenCalled());
});

it("toggles off when already enabled", async () => {
  enabled = true;
  render(<SettingsScreen />);
  const toggle = await screen.findByRole("switch", { name: /open on startup/i });
  await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  fireEvent.click(toggle);
  await waitFor(() => expect(disable).toHaveBeenCalled());
});
```

- [ ] **Step 5:** run → FAIL. Implement `SettingsScreen`: on mount `isEnabled()` → state; toggle calls `enable()`/`disable()` then re-reads `isEnabled()`; render a `role="switch"` button labeled "Open on startup" with helper copy "Launch Conduit in the tray when you log in."; error text via existing copy style on failure. Match existing screen structure/classNames (see Help.tsx for the simplest screen shell).
- [ ] **Step 6:** run tests → PASS (`npx vitest run --maxWorkers=2`).
- [ ] **Step 7:** App.tsx: extend the `View` union with `{ kind: "settings" }`, render `<SettingsScreen />` with the same back-link shell as the help view, and add a "Settings" link next to the existing Help link on the home shell.
- [ ] **Step 8:** Full UI suite + `cargo check -p conduit-ui`. Commit `feat(ui): open-on-startup toggle via tauri-plugin-autostart + Settings screen`.

### Task 5: Daemon bundling + managed install/update

**Files:**
- Create: `scripts/prepare-sidecar.sh` (build daemon + copy with target triple)
- Modify: `ui/src-tauri/tauri.conf.json` (`bundle.externalBin`)
- Modify: `ui/src-tauri/src/setup.rs` (bundled-binary discovery, version drift)
- Modify: `ui/src/screens/Setup.tsx` (Update-daemon affordance)
- Test: extend `setup.rs` unit tests + `ui/src/screens` tests if Setup has them

**Interfaces:**
- Consumes: existing `setup_status`/`setup_install_service` commands and `find_conduit_daemon_binary_excluding` helper.
- Produces: `SetupStatus` gains `daemon_version: Option<String>` and `app_version: String`; sidecar at `ui/src-tauri/bin/conduit-daemon-<triple>`.

- [ ] **Step 1:** `scripts/prepare-sidecar.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
triple=$(rustc -vV | sed -n 's/^host: //p')
cargo build --release -p conduit-daemon
mkdir -p ui/src-tauri/bin
cp target/release/conduit-daemon "ui/src-tauri/bin/conduit-daemon-${triple}"
echo "sidecar ready: ui/src-tauri/bin/conduit-daemon-${triple}"
```

`chmod +x`; add `ui/src-tauri/bin/` to `.gitignore`.
- [ ] **Step 2:** tauri.conf.json bundle += `"externalBin": ["bin/conduit-daemon"]`.
- [ ] **Step 3:** setup.rs — bundled binary discovery: prefer the sidecar sitting next to the current exe (AppImage layout) before the existing search paths in `find_conduit_daemon_binary_excluding` (unit-testable helper `sidecar_candidate(exe_dir: &Path) -> PathBuf` returning `exe_dir.join("conduit-daemon")`); extend `SetupStatus` with `daemon_version: Option<String>` (from the socket `get_status` response's `version` field, `None` when socket unreachable) and `app_version: String` (`env!("CARGO_PKG_VERSION")`). Cargo test: `sidecar_candidate` path join + a version-compare helper `daemon_outdated(daemon: Option<&str>, app: &str) -> bool` (true only when `Some(v)` and `v != app`).
- [ ] **Step 4:** Setup.tsx: when `daemon_outdated`, show "Engine update available — Update now" calling the existing `setup_install_service` command (it already copies binary + unit + restarts); success re-polls status. Follow the screen's existing status-pill idioms.
- [ ] **Step 5:** `cargo test --workspace` + UI suite green; `bash scripts/prepare-sidecar.sh` produces the sidecar locally. Commit `feat(setup): bundled daemon sidecar with managed install/update`.

### Task 6: release.yml

**Files:**
- Create: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `scripts/prepare-sidecar.sh` (Task 5), version source (Task 1's guard convention), AppImage bundling (Tasks 2–5).

- [ ] **Step 1:** Write the workflow:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

env:
  CARGO_TERM_COLOR: always

jobs:
  test:
    name: Tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install system deps
        run: |
          sudo apt-get update
          sudo apt-get install -y libudev-dev libwebkit2gtk-4.1-dev \
            build-essential libxdo-dev libssl-dev \
            libayatana-appindicator3-dev librsvg2-dev
      - uses: Swatinem/rust-cache@v2
      - run: cargo test --workspace
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: ui/package-lock.json
      - run: npm ci
        working-directory: ui
      - run: npx vitest run --maxWorkers=2
        working-directory: ui

  build:
    name: AppImage
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Version guard
        run: |
          tag="${GITHUB_REF_NAME#v}"
          conf=$(python3 -c "import json;print(json.load(open('ui/src-tauri/tauri.conf.json'))['version'])")
          test "$tag" = "$conf" || { echo "tag v$tag != tauri.conf version $conf"; exit 1; }
      - name: Install system deps
        run: |
          sudo apt-get update
          sudo apt-get install -y libudev-dev libwebkit2gtk-4.1-dev \
            build-essential libxdo-dev libssl-dev \
            libayatana-appindicator3-dev librsvg2-dev libfuse2
      - uses: Swatinem/rust-cache@v2
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: ui/package-lock.json
      - run: npm ci
        working-directory: ui
      - name: Build daemon sidecar
        run: bash scripts/prepare-sidecar.sh
      - name: Build AppImage
        run: npx tauri build
        working-directory: ui
      - name: Create draft release with AppImage
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          appimage=$(ls target/release/bundle/appimage/*.AppImage)
          gh release create "$GITHUB_REF_NAME" --draft --generate-notes \
            --title "conduit $GITHUB_REF_NAME" "$appimage"

  publish:
    name: Publish release
    needs: [test, build]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Undraft
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh release edit "$GITHUB_REF_NAME" --draft=false
```

- [ ] **Step 2:** `actionlint` if available (`npx -y @rhysd/actionlint-bin` or skip if not installable) / YAML sanity via `python3 -c "import yaml,sys;yaml.safe_load(open('.github/workflows/release.yml'))"`.
- [ ] **Step 3:** Commit `feat(ci): tag-driven AppImage release workflow`.

Note: the AppImage bundle path is `target/release/bundle/appimage/` at the workspace root because the workspace target dir is shared; verify locally in Task 7 and correct the glob if Tauri emits under `ui/src-tauri/target` instead.

### Task 7: Local AppImage smoke test + docs

**Files:**
- Modify: `README.md` (Install section: download AppImage, first-run setup, startup toggle)
- Possibly fix: release.yml glob / bundle paths discovered here

**Interfaces:** consumes everything above.

- [ ] **Step 1:** `bash scripts/prepare-sidecar.sh && cd ui && npx tauri build` (PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig on this machine). Note the real AppImage output path; fix Task 6 glob if needed.
- [ ] **Step 2:** Run the AppImage: window shows; tray works; `--hidden` starts tray-only; Settings toggle writes `~/.config/autostart/conduit.desktop` (verify content includes `--hidden`); Setup screen shows daemon status and the Update path works against the live service.
- [ ] **Step 3:** README section (Install → AppImage steps, what the Setup screen does, startup toggle location). Commit `docs: AppImage install + startup documentation`.
