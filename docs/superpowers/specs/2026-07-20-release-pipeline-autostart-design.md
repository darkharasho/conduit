# Release Pipeline (Linux AppImage) + Tray & Open-on-Startup — Design

**Date:** 2026-07-20
**Status:** Approved

## Goal

Tag-driven GitHub release producing a single Linux AppImage that contains the
UI app and the `conduit-daemon` binary, plus a tray icon and an
"Open on startup" toggle. Structure modeled on SAI's release workflow
(tag `v*` → test → build → publish); tooling is Tauri v2, not electron-builder.

## Scope decisions

- Linux AppImage only. No Windows/macOS, no signing, no auto-updater.
- Daemon ships inside the AppImage (`externalBin`); the app's Setup flow
  installs/updates it. No second release artifact.
- Manual build steps + gh CLI in the workflow (no `tauri-apps/tauri-action`).
- Versioning stays manual with a sync script + workflow guard.
- Startup semantics: manual launch opens the window; autostart launches with
  `--hidden` (tray only); titlebar close hides to tray; tray menu Quit exits.

## Components

### 1. Release workflow — `.github/workflows/release.yml`

- Trigger: `push: tags: ['v*']`; `permissions: contents: write`.
- `test` job: same system deps as ci.yml; `cargo test --workspace` +
  `npx vitest run` + `npm run build` (ui).
- `build` job (`needs: test`): version guard (tag `v$X` must equal
  `tauri.conf.json` version, else fail), `cargo build --release -p
  conduit-daemon`, copy binary to the `externalBin` path with target-triple
  suffix, `npx tauri build` (AppImage bundle), `gh release create "$TAG"
  --draft --generate-notes` + upload the AppImage
  (`GH_TOKEN: secrets.GITHUB_TOKEN`).
- `publish` job (`needs: [test, build]`): `gh release edit "$TAG"
  --draft=false` (SAI's un-draft pattern).

### 2. Versioning

- Source of truth: `ui/src-tauri/tauri.conf.json` `version`.
- `scripts/bump-version.mjs` (run as `npm run bump -- 0.2.0` from root):
  rewrites `tauri.conf.json`, `ui/package.json`, `ui/src-tauri/Cargo.toml`
  in place; refuses non-semver input. Unit-tested.
- Workflow guard compares tag to `tauri.conf.json`.

### 3. Icons

- New original geometric "conduit" mark (SVG, drawn for this project),
  rendered to 1024px PNG, then `tauri icon` generates the icon set into
  `ui/src-tauri/icons/`; `bundle.icon` lists the generated files. The same
  mark is used for the tray icon. User sees the mark before first release.

### 4. Daemon bundling + managed install

- `tauri.conf.json` `bundle.externalBin: ["bin/conduit-daemon"]`; build step
  places `bin/conduit-daemon-<target-triple>` under `ui/src-tauri/`.
- Setup screen gains a "daemon" step backed by new Tauri commands in
  `ui/src-tauri/src/setup.rs`:
  - `daemon_status()` → { installed: bool, running: bool, daemon_version:
    Option<String> (from socket get_status), app_version: String }.
  - `daemon_install()` → copy bundled binary to `~/.local/bin/conduit-daemon`,
    write `~/.config/systemd/user/conduit.service` (content vendored from
    `packaging/conduit.service`), `systemctl --user daemon-reload && enable
    --now conduit`. Idempotent; also used for updates (overwrite + restart).
- UI: Setup screen shows install state; when socket version ≠ app version,
  shows an "Update daemon" action calling `daemon_install()`.

### 5. Tray + open on startup

- Tauri v2 built-in `TrayIcon` (`tauri = { features = ["tray-icon"] }`):
  menu "Open Conduit" (show + focus window) and "Quit" (exit process).
- Close behavior: intercept window close → hide window (app keeps running in
  tray). Quit only via tray menu.
- `--hidden` CLI flag: when present, the main window is not shown at launch.
- `tauri-plugin-autostart` (Cargo + JS package + capability permissions),
  configured with `MacosLauncher::LaunchAgent` default arg `--hidden`; on
  Linux it writes an XDG autostart entry pointing at the running AppImage
  (auto-launch crate reads `$APPIMAGE`).
- New Settings screen (`ui/src/screens/Settings.tsx` + nav-rail entry in
  `App.tsx`): "Open on startup" toggle calling the plugin's
  enable/disable/isEnabled; shows the resolved state on load.

## Error handling

- Workflow: version-guard failure and any build failure abort before a
  release is created; draft releases mean a half-finished run never
  publishes.
- `daemon_install()` surfaces stderr of failed systemctl/copy steps to the
  UI as the existing ErrorPayload pattern.
- Autostart toggle reflects `isEnabled()` truth on every Settings mount, so
  a failed enable never shows a stale "on".
- Tray/`--hidden` degrade safely: if tray creation fails, the window shows
  normally and quit works via window close (fallback flag).

## Testing

- `bump-version.mjs`: node test for rewrite + rejection cases.
- Settings screen + Setup daemon step: vitest component tests (mock tauri
  invoke).
- setup.rs pure helpers (unit file content, version compare): cargo tests.
- Local smoke test before first tag: `npx tauri build`, run the AppImage,
  verify tray, --hidden, daemon install path on this machine.
