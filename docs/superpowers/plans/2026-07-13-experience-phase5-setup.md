# Experience Redesign Phase 5: Setup Helper & First-Run/Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. ALL implementer/fixer dispatches carry the anti-delegation contract (standing ledger rule).

**Goal:** Replace the shell-command wall with spec Section 5: a guided setup screen whose steps are consequences ("Background service installed"), a single-password-prompt privileged fix, capability-based checks that don't nag about groups when logind ACLs already grant access, an engine-stopped recovery card with "Start it again" and "Copy report for a bug", and the technical-details quarantine.

**Architecture:** The daemon's `--check` becomes capability-based (`evdev_ok` = can actually read an input device; `uinput_ok` = can actually open /dev/uinput — group membership demoted to a remediation hint). A new `setup.rs` module in the Tauri shell owns: a detailed status probe, an unprivileged service installer (binary copy + unit write + `systemctl --user enable --now` — no root needed), ONE `pkexec sh -c` batch for the two genuinely-root fixes (udev rule + input group), an engine restarter, and a report collector. A new Setup screen renders the mockup's step cards for both first-run and recovery, re-checking on window focus and a 5s poll; `SetupCheck.tsx` and its `cargo build` commands die.

**Tech Stack:** Rust (Tauri shell: std::process, pkexec/systemctl/udevadm/usermod at runtime), React + TypeScript (vitest, fireEvent), polkit via `pkexec` (verified present at /usr/bin/pkexec).

## Global Constraints

- Before any `cargo` command: `export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig`.
- Vitest cap 2; `npx vitest run` from `ui/`; `npx tsc --noEmit` clean; fix-round verifications include tsc.
- Machine facts that shape correctness: uinput access can come from logind ACLs (`user:mstephens:rw-` on /dev/uinput) with the user NOT in the input group — capability checks must therefore be attempted-operation-based, never group-based. `pkexec`, `systemctl`, `udevadm`, `usermod`, `loginctl` all exist at /usr/bin.
- Exactly ONE password prompt for privileged fixes: both root operations (udev rule install+reload, `usermod -aG input`) execute in a single `pkexec sh -c '…'` invocation. Unprivileged operations (service install) never touch pkexec.
- Spec/mockup copy verbatim: title "Let's get Conduit running"; subtitle "Conduit needs a couple of one-time permissions to remap your devices. You'll be asked for your password once."; steps "Background service installed" / "Starts with your computer, stays out of the way", "Allowing Conduit to press keys for you", "Access to your mice and keyboards" / "May need you to log out and back in — we'll tell you if so"; CTA "Start using Conduit"; link "Show technical details"; recovery title "Conduit's engine stopped" with button "Start it again"; failure escape "Copy report for a bug"; relogin instruction "Log out and back in, then come back — your settings will be waiting."
- Jargon ban (rendered copy outside the technical-details pane): no "daemon", "socket", "uinput", "udev", "systemd", "polkit", "evdev", "group", "profile", raw paths, or shell commands. INSIDE the details pane, raw output is expected and quarantined (renders ONLY after clicking "Show technical details").
- The unit file written by setup is byte-equivalent to packaging/conduit.service (ExecStart=%h/.local/bin/conduit-daemon, Restart=on-failure, RestartSec=1, WantedBy=default.target). The udev rule written is byte-equivalent to packaging/99-conduit.rules' KERNEL line.
- No live system mutation in any automated test: command-executing Rust functions are thin wrappers around tested pure builders; tests never run pkexec/systemctl. The coordinator's Task 6 live smoke asks the user before installing the real service.
- Every task ends green: `cargo test --workspace`, `cargo test --manifest-path ui/src-tauri/Cargo.toml`, `cd ui && npx vitest run && npx tsc --noEmit`.

---

### Task 1: Daemon — capability-based `--check` v2

**Files:**
- Modify: `crates/conduit-daemon/src/main.rs` (`run_check` :217–243, `check_input_group` :246–255)

**Interfaces:**
- Produces: `--check` prints one JSON object with fields `{"uinput":bool,"evdev":bool,"input_group":bool,"config_ok":bool}` — `evdev` is NEW: true iff at least one `/dev/input/event*` opens for read (O_RDONLY|O_NONBLOCK). `input_group` stays (remediation hint only). Old consumers tolerate the extra field (Tauri parses with serde into a struct that gains the field with `#[serde(default)]`).

- [ ] **Step 1: Extract testable helpers + failing tests** (in main.rs or a new `check.rs` module — prefer `crates/conduit-daemon/src/check.rs` with `pub fn run_check_json(paths: &CheckPaths) -> String` where `CheckPaths { uinput: PathBuf, input_dir: PathBuf, config: PathBuf }` so tests can point at temp dirs):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evdev_false_when_no_readable_event_nodes() {
        let t = std::env::temp_dir().join(format!("conduit-chk-{}", std::process::id()));
        std::fs::create_dir_all(&t).unwrap();
        let paths = CheckPaths {
            uinput: t.join("nonexistent-uinput"),
            input_dir: t.clone(),          // empty dir: no event* nodes
            config: t.join("missing.toml"), // missing config is OK
        };
        let json = run_check_json(&paths);
        assert!(json.contains("\"evdev\":false"), "{json}");
        assert!(json.contains("\"uinput\":false"), "{json}");
        assert!(json.contains("\"config_ok\":true"), "{json}");
        std::fs::remove_dir_all(&t).ok();
    }

    #[test]
    fn evdev_true_when_a_readable_event_node_exists() {
        let t = std::env::temp_dir().join(format!("conduit-chk2-{}", std::process::id()));
        std::fs::create_dir_all(&t).unwrap();
        std::fs::write(t.join("event0"), b"").unwrap(); // plain readable file stands in
        let paths = CheckPaths { uinput: t.join("x"), input_dir: t.clone(), config: t.join("c.toml") };
        let json = run_check_json(&paths);
        assert!(json.contains("\"evdev\":true"), "{json}");
        std::fs::remove_dir_all(&t).ok();
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p conduit-daemon check` → compile error (module missing).

- [ ] **Step 3: Implement** — `check.rs`: `CheckPaths` with a `Default` returning the real paths (`/dev/uinput`, `/dev/input`, `paths::config_path()`); `evdev_ok` = read_dir(input_dir) → any entry whose file_name starts with "event" and `OpenOptions::new().read(true).custom_flags(O_NONBLOCK).open(...)` succeeds; uinput/config logic moved from main.rs unchanged; `input_group` via the existing `check_input_group`. `run_check_json` formats all four fields. main.rs `--check` calls `println!("{}", check::run_check_json(&CheckPaths::default()))`.

- [ ] **Step 4: Full daemon suite** — `cargo test -p conduit-daemon` → PASS; manual sanity: `target/debug/conduit-daemon --check` on this machine prints `"uinput":true,"evdev":true,"input_group":false,"config_ok":true` (ACL machine).

- [ ] **Step 5: Commit** — `git commit -m "feat(daemon): capability-based --check with evdev probe"`

---

### Task 2: Tauri setup module — status, installers, report

**Files:**
- Create: `ui/src-tauri/src/setup.rs`
- Modify: `ui/src-tauri/src/lib.rs` (register commands; extend `DaemonCheckOutput` with `#[serde(default)] evdev: bool`; keep `check_setup` working)
- Modify: `ui/src/lib/client.ts` (+ client.test.ts append)

**Interfaces:**
- Produces (Tasks 3–5 rely on):

```rust
// setup.rs — PURE, unit-tested:
pub const SERVICE_UNIT: &str = "[Unit]\nDescription=Conduit input remapping daemon\n\n[Service]\nExecStart=%h/.local/bin/conduit-daemon\nRestart=on-failure\nRestartSec=1\n\n[Install]\nWantedBy=default.target\n";
pub const UDEV_RULE: &str = "KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\", OPTIONS+=\"static_node=uinput\"\n";
pub fn fix_permissions_script(user: &str) -> String;
// => "set -e\nmkdir -p /etc/udev/rules.d\nprintf '%s' '<UDEV_RULE>' > /etc/udev/rules.d/99-conduit.rules\nudevadm control --reload\nudevadm trigger\nusermod -aG input <user>\n"
// (single-quoted rule embedding; user validated [a-z_][a-z0-9_-]* — reject otherwise)
pub fn assemble_report(sections: &[(&str, &str)]) -> String; // "== {title} ==\n{body}\n\n" per section
```

```rust
// Commands (thin, untested wrappers):
setup_status() -> Result<SetupStatus, ErrorPayload>
  // SetupStatus { service_installed: bool (unit file exists), service_running: bool (systemctl --user is-active),
  //   daemon_connected: bool (socket), uinput_ok, evdev_ok, input_group, config_ok (from --check via
  //   find_conduit_daemon_binary; all false + binary_missing=true when absent), binary_path: Option<String>,
  //   details: Vec<String> }  // raw probe outputs for the quarantine pane
setup_install_service() -> Result<(), ErrorPayload>
  // ensure ~/.local/bin/conduit-daemon (copy from find_conduit_daemon_binary source if missing; error
  //   "Conduit's engine program is missing from this build" code internal when unfindable);
  // write ~/.config/systemd/user/conduit.service = SERVICE_UNIT (create_dir_all);
  // systemctl --user daemon-reload && systemctl --user enable --now conduit.service; error detail = stderr.
setup_fix_permissions() -> Result<PermissionFixOutcome, ErrorPayload>
  // whoami → fix_permissions_script → pkexec sh -c <script>.
  // exit 126/127 (dismissed prompt) → ErrorPayload::new("permission-denied", "You closed the password prompt", stderr)
  // PermissionFixOutcome { relogin_needed: bool } — true iff usermod ran (script succeeded) AND current
  //   process groups still lack input (relogin pending); false when the rule alone fixed uinput.
restart_engine() -> Result<(), ErrorPayload>   // systemctl --user restart conduit.service; stderr as detail
collect_report() -> Result<String, ErrorPayload>
  // assemble_report over: ("check", --check stdout), ("service", systemctl --user status conduit.service -n 0 output),
  // ("journal", journalctl --user -u conduit.service -n 50 --no-pager output), ("versions", app+daemon versions)
```

```typescript
// client.ts
export interface SetupStatus { service_installed: boolean; service_running: boolean; daemon_connected: boolean;
  uinput_ok: boolean; evdev_ok: boolean; input_group: boolean; config_ok: boolean;
  binary_path: string | null; details: string[]; }
export interface PermissionFixOutcome { relogin_needed: boolean; }
export async function setupStatus(): Promise<SetupStatus>;
export async function setupInstallService(): Promise<void>;
export async function setupFixPermissions(): Promise<PermissionFixOutcome>;
export async function restartEngine(): Promise<void>;
export async function collectReport(): Promise<string>;
```

- [ ] **Step 1: Failing Rust tests** (setup.rs pure fns):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_and_rule_match_packaging_files() {
        let unit = std::fs::read_to_string(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../packaging/conduit.service")).unwrap();
        assert_eq!(SERVICE_UNIT, unit);
        let rule = std::fs::read_to_string(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../packaging/99-conduit.rules")).unwrap();
        assert!(rule.ends_with(UDEV_RULE), "packaging rule must end with the KERNEL line");
    }

    #[test]
    fn fix_script_is_single_prompt_batch_and_validates_user() {
        let s = fix_permissions_script("mstephens");
        assert!(s.starts_with("set -e\n"));
        assert!(s.contains("/etc/udev/rules.d/99-conduit.rules"));
        assert!(s.contains("udevadm control --reload"));
        assert!(s.contains("usermod -aG input mstephens"));
        assert!(!s.contains("pkexec"), "script runs UNDER pkexec, never invokes it");
    }

    #[test]
    #[should_panic]
    fn fix_script_rejects_hostile_usernames() {
        fix_permissions_script("evil; rm -rf /");
    }

    #[test]
    fn report_sections_are_titled() {
        let r = assemble_report(&[("check", "{}"), ("journal", "line1\nline2")]);
        assert!(r.contains("== check ==\n{}"));
        assert!(r.contains("== journal ==\nline1\nline2"));
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test --manifest-path ui/src-tauri/Cargo.toml --lib` → compile error.

- [ ] **Step 3: Implement** setup.rs per the Interfaces block (username validation: panic-free `Result` is fine too — then change the test from should_panic to `assert!(fix_permissions_script_checked("evil; rm -rf /").is_err())`; pick one and keep the test honest). Commands registered in `generate_handler!`. client.ts bindings through `call<T>`; client.test.ts: one passthrough test per new fn (mock resolve, assert invoke name).

- [ ] **Step 4: All gates** — Rust shell tests + build + full UI suite + tsc → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat(tauri): setup module — status probe, installers, one-prompt fix, report"`

---

### Task 3: Setup screen — first-run variant

**Files:**
- Create: `ui/src/screens/Setup.tsx`, `ui/src/screens/Setup.test.tsx`
- Modify: `ui/src/App.css` (append)

**Interfaces:**
- Produces: `SetupScreen({ onReady }: { onReady?: () => void })` — self-contained: polls `setupStatus()` on mount. Renders per the approved mockup:
  1. hero art (reuse `DeviceArt` mouse + keyboard side by side at small size), title + subtitle (verbatim copy);
  2. three step cards derived from SetupStatus:
     - "Background service installed" — done when `service_installed && service_running`; attention state shows button "Set it up" → `setupInstallService()` then re-check; note "Starts with your computer, stays out of the way".
     - "Allowing Conduit to press keys for you" — done when `uinput_ok`; attention → button "Allow" → `setupFixPermissions()`; while awaiting pkexec: spinner + "Waiting for your password in the system dialog…".
     - "Access to your mice and keyboards" — done when `evdev_ok`; attention → same `setupFixPermissions()` flow (one click may green both); note "May need you to log out and back in — we'll tell you if so"; when the fix returns `relogin_needed: true` → persistent info state "Log out and back in, then come back — your settings will be waiting."
  3. primary CTA "Start using Conduit" — enabled iff `daemon_connected`; onClick → `onReady?.()`;
  4. quiet link "Show technical details" toggling a `<pre className="setup__details">` of `status.details.join("\n")` — raw content NEVER rendered before the click (jargon quarantine).
  - Step order is fixed; states: done (✓), active (spinner while a fix runs), attention (button), pending (number). Errors from a fix render inside that step card as `presentError(err).title` (plain), with the raw detail going only into the details pane data.

- [ ] **Step 1: Failing tests** (mock client per Home.test.tsx's vi.hoisted full-mock pattern; fireEvent). Shared fixtures at the top of the test file:

```tsx
const ALL_BROKEN: SetupStatus = {
  service_installed: false, service_running: false, daemon_connected: false,
  uinput_ok: false, evdev_ok: false, input_group: false, config_ok: true,
  binary_path: "/home/u/.local/bin/conduit-daemon", details: [],
};
const ALL_GREEN: SetupStatus = {
  ...ALL_BROKEN, service_installed: true, service_running: true,
  daemon_connected: true, uinput_ok: true, evdev_ok: true,
};
```


```tsx
it("renders the hero copy and three steps from status", async () => {
  mockSetupStatus.mockResolvedValue(ALL_BROKEN); // service off, uinput false, evdev false
  render(<SetupScreen />);
  expect(await screen.findByText("Let's get Conduit running")).toBeInTheDocument();
  expect(screen.getByText("Background service installed")).toBeInTheDocument();
  expect(screen.getByText("Allowing Conduit to press keys for you")).toBeInTheDocument();
  expect(screen.getByText("Access to your mice and keyboards")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start using Conduit" })).toBeDisabled();
});

it("quarantines technical details behind the link", async () => {
  mockSetupStatus.mockResolvedValue({ ...ALL_BROKEN, details: ["uinput: EACCES /dev/uinput"] });
  render(<SetupScreen />);
  await screen.findByText("Let's get Conduit running");
  expect(screen.queryByText(/EACCES|uinput/)).toBeNull();
  fireEvent.click(screen.getByText("Show technical details"));
  expect(screen.getByText(/EACCES/)).toBeInTheDocument();
});

it("installs the service on Set it up and re-checks", async () => {
  mockSetupStatus.mockResolvedValueOnce(ALL_BROKEN)
    .mockResolvedValue({ ...ALL_BROKEN, service_installed: true, service_running: true, daemon_connected: true });
  mockSetupInstallService.mockResolvedValue(undefined);
  render(<SetupScreen />);
  fireEvent.click(await screen.findByRole("button", { name: "Set it up" }));
  await waitFor(() => expect(mockSetupInstallService).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start using Conduit" })).toBeEnabled());
});

it("shows the relogin instruction when the fix needs it", async () => {
  mockSetupStatus.mockResolvedValue({ ...ALL_BROKEN, service_running: true, uinput_ok: true });
  mockSetupFixPermissions.mockResolvedValue({ relogin_needed: true });
  render(<SetupScreen />);
  fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
  expect(await screen.findByText("Log out and back in, then come back — your settings will be waiting.")).toBeInTheDocument();
});

it("never renders banned words outside the details pane", async () => {
  mockSetupStatus.mockResolvedValue(ALL_BROKEN);
  const { container } = render(<SetupScreen />);
  await screen.findByText("Let's get Conduit running");
  for (const word of ["daemon", "socket", "uinput", "udev", "systemd", "polkit", "group", "profile"]) {
    expect(container.textContent!.toLowerCase()).not.toContain(word);
  }
});
```

- [ ] **Step 2: Run to verify failure** — module missing.
- [ ] **Step 3: Implement** per the Interfaces block; CSS append (`.setup`, `.setup__step`, `.setup__step--done/--active/--attention/--pending`, `.setup__ico`, `.setup__cta`, `.setup__details`, spinner reuse) with existing tokens.
- [ ] **Step 4: Full UI suite + tsc** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): guided setup screen with one-prompt fixes and details quarantine"`

---

### Task 4: Recovery variant + wiring — SetupCheck dies

**Files:**
- Modify: `ui/src/screens/Setup.tsx` (+ Setup.test.tsx append)
- Modify: `ui/src/App.tsx` (recovery branch), `ui/src/screens/Status.tsx` (:45), delete `ui/src/components/SetupCheck.tsx`
- Test: `ui/src/App.test.tsx` (append/adjust)

**Interfaces:**
- Produces: `SetupScreen` gains `variant?: "firstrun" | "recovery"` (default "firstrun"). Recovery rendering rule: when `variant === "recovery"` AND `service_installed && !daemon_connected` → instead of three cards, ONE card: title "Conduit's engine stopped", body "Your buttons are back to their normal behavior until it starts again." (reuses the Phase 1 error-table copy), button "Start it again" → `restartEngine()` then re-check; after a restart attempt that still leaves `daemon_connected` false → additional quiet button "Copy report for a bug" → `collectReport()` → `navigator.clipboard.writeText(report)` → inline confirmation "Copied. Paste it into a bug report." When the service was never installed, recovery falls through to the normal three-step first-run layout (fresh machine case).
- App.tsx: `connected === false` home branch renders `<SetupScreen variant="recovery" />` (replacing SetupCheck); Status.tsx:45 same swap; `SetupCheck.tsx` deleted along with its command constants; any tests referencing SetupCheck updated (list in commit body).

- [ ] **Step 1: Failing tests**

```tsx
it("recovery shows Start it again and escalates to Copy report", async () => {
  mockSetupStatus.mockResolvedValue({ ...ALL_GREEN, daemon_connected: false, service_running: false });
  mockRestartEngine.mockResolvedValue(undefined); // restart "succeeds" but daemon stays down
  mockCollectReport.mockResolvedValue("== check ==\n{}");
  render(<SetupScreen variant="recovery" />);
  expect(await screen.findByText("Conduit's engine stopped")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Start it again" }));
  await waitFor(() => expect(mockRestartEngine).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole("button", { name: "Copy report for a bug" }));
  await waitFor(() => expect(screen.getByText("Copied. Paste it into a bug report.")).toBeInTheDocument());
});

it("recovery falls through to first-run when the service was never installed", async () => {
  mockSetupStatus.mockResolvedValue(ALL_BROKEN); // service_installed false
  render(<SetupScreen variant="recovery" />);
  expect(await screen.findByText("Let's get Conduit running")).toBeInTheDocument();
});
```

(`navigator.clipboard` mock: `Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })` in the test setup — jsdom lacks it.)

- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**; delete SetupCheck.tsx; swap both render sites; App.test adjustments.
- [ ] **Step 4: Full UI suite + tsc; grep `SetupCheck` returns nothing.** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): engine recovery with Start it again and report copy; SetupCheck removed"`

---

### Task 5: Live re-checking — focus, poll, and relogin resume

**Files:**
- Modify: `ui/src/screens/Setup.tsx` (+ Setup.test.tsx append)

**Interfaces:**
- Produces: while mounted, SetupScreen re-runs `setupStatus()`: (a) every 5000ms (`setInterval`, cleaned up on unmount); (b) on window `focus` events (the relogin-return case). A re-check that flips `daemon_connected` true in recovery variant renders a success state: "Everything's running again." with the CTA "Start using Conduit" (same `onReady` path). Re-checks never stack (an in-flight guard ref).

- [ ] **Step 1: Failing tests** (fake timers):

```tsx
it("re-checks on interval and on window focus", async () => {
  vi.useFakeTimers();
  mockSetupStatus.mockResolvedValue(ALL_BROKEN);
  render(<SetupScreen />);
  await act(async () => { await Promise.resolve(); });
  const initial = mockSetupStatus.mock.calls.length;
  await act(async () => { vi.advanceTimersByTime(5100); });
  expect(mockSetupStatus.mock.calls.length).toBeGreaterThan(initial);
  const afterTick = mockSetupStatus.mock.calls.length;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(mockSetupStatus.mock.calls.length).toBeGreaterThan(afterTick);
  vi.useRealTimers();
});
```

- [ ] **Step 2–4:** fail → implement → full suite + tsc PASS (ensure the interval uses a ref-guard so overlapping checks are skipped; unmount clears interval + listener).
- [ ] **Step 5: Commit** — `git commit -m "feat(ui): setup screen re-checks on focus and interval for relogin resume"`

---

### Task 6: Phase verification (coordinator)

**Files:** none expected.

- [ ] **Step 1: Full gates** — workspace + tauri crate + UI suite + tsc.
- [ ] **Step 2: Probe-only smoke (no mutation)** — run the built `conduit-daemon --check` and the app's `setup_status` logic path by hand (binary + JSON shape on this machine: expect `uinput:true, evdev:true, input_group:false, config_ok:true`, service_installed:false).
- [ ] **Step 3: LIVE INSTALL SMOKE — ASK THE USER FIRST.** This installs the real user service on this machine (the product's intended end state, and the standing "no daemon service installed" memory becomes obsolete): with consent, drive `setup_install_service` equivalent (`install -D` unit + `systemctl --user daemon-reload && enable --now conduit.service`), verify `systemctl --user is-active conduit.service` = active, the app connects (socket exists), and `journalctl --user -u conduit.service -n 5` shows startup lines. If the user declines, record the deferral in the ledger; the pkexec permission fix is NOT exercised live either way (this machine's ACLs already grant access — nothing to fix).
- [ ] **Step 4: Update the machine memory** — if the live install ran, update the `no-daemon-service-installed` memory file to reflect the installed service.

## Out of scope (Phase 6 / later)

- Bundling the daemon binary as a Tauri sidecar/resource for distributable builds (setup uses the existing binary-search; packaging story is its own effort).
- A dedicated polkit policy file (pkexec's default admin prompt is acceptable v1; a policy would allow custom message text).
- Uninstall/teardown flow.
- KeyTester/Status remaining technical wording (Phase 6 sweep, along with the accumulated dead-CSS list).
