# Experience Redesign Phase 1: UX Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace string errors with a typed error envelope, add versioned config apply with status confirmation, and give the UI a plain-language error table — the protocol foundation for the experience redesign (spec: `docs/superpowers/specs/2026-07-13-experience-redesign-design.md`, Section 6).

**Architecture:** The proto crate gains an `ErrorCode` enum and a richer `Response::Err`; the daemon classifies every error site and allocates a monotonic config version shared between the IPC handler and the file watcher; the Tauri shell converts errors to a structured payload instead of `String`; `client.ts` normalizes rejections into a `ConduitError` class; a new `error-messages.ts` maps codes to plain sentences + recovery actions. Wire compatibility is kept via `#[serde(default)]` so old/new peers parse each other.

**Tech Stack:** Rust (serde, crossbeam-channel), TypeScript (Tauri v2 `invoke`, vitest + jsdom).

## Global Constraints

- Before any `cargo` command: `export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig` (linuxbrew pkg-config shadows the system one on this machine).
- Vitest is capped at 2 workers by `ui/vitest.config.ts` (`maxForks: 2`) — do not raise it; run as `npx vitest run` from `ui/`.
- Error code wire strings are kebab-case exactly as in the spec: `engine-not-running`, `permission-denied`, `device-missing`, `config-invalid`, `apply-failed`, `malformed-request`, `timeout`, `internal`.
- The TOML config format does not change. No changes under `crates/conduit-core`.
- `FocusInfo` does not change in this phase: `class` already carries the Wayland app_id on KWin (`resource_class`, `focus/kde.rs:100`) and Hyprland; desktop-entry resolution ships with the app picker in Phase 4.
- Every task ends with all tests green: `cargo test -p conduit-proto -p conduit-daemon` and `cd ui && npx vitest run`.

---

### Task 1: Proto — `ErrorCode` enum and typed `Response::Err`

**Files:**
- Modify: `crates/conduit-proto/src/lib.rs` (Response enum at lines 25–36; tests module at 104–191)

**Interfaces:**
- Produces: `ErrorCode` (kebab-case serde enum with `as_str()`), `Response::Err { code, message, detail, params }`, constructors `Response::error(code, message)` and `Response::error_detail(code, message, detail)`. Tasks 2–4 use these exact names.

- [ ] **Step 1: Write the failing tests** (append inside the existing `mod tests`)

```rust
    #[test]
    fn error_code_wire_strings_are_kebab_case() {
        assert_eq!(
            serde_json::to_string(&ErrorCode::EngineNotRunning).unwrap(),
            r#""engine-not-running""#
        );
        assert_eq!(ErrorCode::ConfigInvalid.as_str(), "config-invalid");
        assert_eq!(ErrorCode::default(), ErrorCode::Internal);
    }

    #[test]
    fn err_envelope_round_trips_and_tolerates_old_shape() {
        let e = Response::error_detail(
            ErrorCode::ConfigInvalid,
            "config rejected",
            "expected ']' at line 3",
        );
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains(r#""code":"config-invalid""#));
        let back: Response = serde_json::from_str(&json).unwrap();
        assert_eq!(e, back);

        // Old daemons send only {type, message}: code defaults to internal.
        let old: Response =
            serde_json::from_str(r#"{"type":"err","message":"boom"}"#).unwrap();
        match old {
            Response::Err { code, message, .. } => {
                assert_eq!(code, ErrorCode::Internal);
                assert_eq!(message, "boom");
            }
            other => panic!("expected Err, got {other:?}"),
        }
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p conduit-proto`
Expected: compile error — `ErrorCode` not found.

- [ ] **Step 3: Implement**

Add above the `Request` enum:

```rust
/// Stable, UI-facing error classification. Wire strings are kebab-case and
/// are a public contract: the UI's plain-language table keys off them.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    EngineNotRunning,
    PermissionDenied,
    DeviceMissing,
    ConfigInvalid,
    ApplyFailed,
    MalformedRequest,
    Timeout,
    Internal,
}

impl Default for ErrorCode {
    fn default() -> Self {
        ErrorCode::Internal
    }
}

impl ErrorCode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ErrorCode::EngineNotRunning => "engine-not-running",
            ErrorCode::PermissionDenied => "permission-denied",
            ErrorCode::DeviceMissing => "device-missing",
            ErrorCode::ConfigInvalid => "config-invalid",
            ErrorCode::ApplyFailed => "apply-failed",
            ErrorCode::MalformedRequest => "malformed-request",
            ErrorCode::Timeout => "timeout",
            ErrorCode::Internal => "internal",
        }
    }
}
```

Replace the `Err { message: String }` variant of `Response` with:

```rust
    Err {
        /// Stable classification; defaults to `internal` when absent so
        /// old peers still parse.
        #[serde(default)]
        code: ErrorCode,
        /// Short technical summary (not shown to end users by default).
        message: String,
        /// Raw underlying error for "Show technical details".
        #[serde(default)]
        detail: String,
        /// Optional structured values (e.g. device name) for UI interpolation.
        #[serde(default)]
        params: std::collections::BTreeMap<String, String>,
    },
```

Add below the `Response` enum:

```rust
impl Response {
    pub fn error(code: ErrorCode, message: impl Into<String>) -> Self {
        Response::Err {
            code,
            message: message.into(),
            detail: String::new(),
            params: Default::default(),
        }
    }

    pub fn error_detail(
        code: ErrorCode,
        message: impl Into<String>,
        detail: impl Into<String>,
    ) -> Self {
        Response::Err {
            code,
            message: message.into(),
            detail: detail.into(),
            params: Default::default(),
        }
    }
}
```

- [ ] **Step 4: Run proto tests**

Run: `cargo test -p conduit-proto`
Expected: PASS (daemon does not compile yet — that is Task 2; do NOT run the workspace build here).

- [ ] **Step 5: Commit**

```bash
git add crates/conduit-proto/src/lib.rs
git commit -m "feat(proto): typed error envelope with stable kebab-case codes"
```

---

### Task 2: Daemon — classify every error site

**Files:**
- Modify: `crates/conduit-daemon/src/ipc.rs` (error constructions at ~lines 150–160 malformed JSON, 202–212 GetConfig read, 354–361 engine query, 365–370 serialization fallback, 408–414 compile failure, 435–450 write failure, 277–289 capture timeout; fixture tests at 466–717)

**Interfaces:**
- Consumes: `Response::error` / `Response::error_detail` / `ErrorCode` from Task 1.
- Produces: every daemon `Response::Err` now carries a code. Mapping (Task 4–6 rely on it): malformed JSON → `MalformedRequest`; config compile failure → `ConfigInvalid` (detail = compiler error); config file read/write failure → `ApplyFailed`; engine thread unavailable → `EngineNotRunning`; capture timeout → `Timeout`; serialization fallback → `Internal`.

- [ ] **Step 1: Write the failing test** (append inside `mod tests` in `ipc.rs`; `set_config` is directly callable with a temp path, a channel, and a gate)

```rust
    #[test]
    fn set_config_invalid_toml_returns_config_invalid_code() {
        let dir = std::env::temp_dir().join(format!("conduit-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("conduit.toml");
        let (tx, _rx) = crossbeam_channel::unbounded();
        let gate = std::sync::Arc::new(std::sync::Mutex::new(crate::watch::ReloadGate::new()));

        let resp = set_config("this is [ not toml", &path, &tx, &gate);
        match resp {
            Response::Err { code, detail, .. } => {
                assert_eq!(code, conduit_proto::ErrorCode::ConfigInvalid);
                assert!(!detail.is_empty(), "detail must carry the compiler error");
            }
            other => panic!("expected Err, got {other:?}"),
        }
        assert!(!path.exists(), "invalid config must not be written");
    }
```

(If `set_config`'s current signature differs from `(toml, path, tx, gate)`, match the real one at `ipc.rs:402` — the assertion body stays the same.)

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p conduit-daemon set_config_invalid_toml`
Expected: compile errors across `ipc.rs` — every `Response::Err { message }` construction no longer matches the new variant shape. This is the safety net: the compiler enumerates every site that needs a code.

- [ ] **Step 3: Convert every error site**

Import `conduit_proto::ErrorCode;` at the top of `ipc.rs`, then replace each construction:

```rust
// malformed JSON (~line 150)
Response::error_detail(ErrorCode::MalformedRequest, "malformed request", e.to_string())

// GetConfig read failure (~line 205)
Response::error_detail(ErrorCode::ApplyFailed, "could not read config file", e.to_string())

// engine thread unavailable, query() (~line 356)
Response::error(ErrorCode::EngineNotRunning, "engine thread unavailable")

// capture timeout (~line 285)
Response::error(ErrorCode::Timeout, "no key pressed within 30s")

// set_config compile failure (~line 410)
Response::error_detail(ErrorCode::ConfigInvalid, "config rejected", e.to_string())

// set_config write failure (~line 440)
Response::error_detail(ErrorCode::ApplyFailed, "writing config failed", e.to_string())
```

Update the hardcoded serialization fallback (~line 367) to:

```rust
let _ = writer.write_all(
    br#"{"type":"err","code":"internal","message":"serialization error"}"#,
);
```

Fix any fixture tests that pattern-match `Response::Err { message }` to use `Response::Err { message, .. }`.

- [ ] **Step 4: Run daemon tests**

Run: `cargo test -p conduit-daemon`
Expected: PASS, including the new test and all existing fixture tests.

- [ ] **Step 5: Commit**

```bash
git add crates/conduit-daemon/src/ipc.rs
git commit -m "feat(daemon): classify every IPC error with a typed code"
```

---

### Task 3: Daemon — versioned config apply

**Files:**
- Modify: `crates/conduit-proto/src/lib.rs` (add `ConfigApplied` response variant; add `Status.config_version`)
- Modify: `crates/conduit-daemon/src/runloop.rs` (`Msg::Reload` at lines 60–78, reload handler at 253–272, `build_status()` at 486–499 and its call sites at 270/284/296)
- Modify: `crates/conduit-daemon/src/ipc.rs` (`set_config()` at 402–462, signature threading at lines 52/64/93/126/189, fixture construction at ~541)
- Modify: `crates/conduit-daemon/src/watch.rs` (reload send at line 144, `spawn`/`poll_loop` signatures at 84/92)
- Modify: `crates/conduit-daemon/src/lib.rs` (wiring at ~line 192)

**Interfaces:**
- Consumes: Task 1's proto layout.
- Produces: `Response::ConfigApplied { version: u64 }` returned by SetConfig; `Status.config_version: u64` (`#[serde(default)]`); `Msg::Reload(CompiledConfig, u64)`; a shared `Arc<AtomicU64>` version counter (name it `config_version`) owned by `lib.rs` and passed to both `ipc::serve` and `watch::spawn`. Version allocation: `counter.fetch_add(1, Ordering::SeqCst) + 1` at each send site; the runloop stores the value from the latest processed `Msg::Reload` and reports it in every `Status`. Task 4 parses `ConfigApplied`; the UI (later phases) matches `Status.config_version >= returned version` to confirm an apply landed.

- [ ] **Step 1: Write the failing proto test** (in `conduit-proto` tests)

```rust
    #[test]
    fn config_applied_and_status_version_wire_shapes() {
        assert_eq!(
            serde_json::to_string(&Response::ConfigApplied { version: 7 }).unwrap(),
            r#"{"type":"config_applied","version":7}"#
        );
        // Old daemons omit config_version: defaults to 0.
        let s: Status = serde_json::from_str(
            r#"{"active_profile":"default","active_layers":[],"suspended":false,"focus":null,"grabbed_devices":[],"version":"0.1.0"}"#,
        ).unwrap();
        assert_eq!(s.config_version, 0);
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p conduit-proto config_applied`
Expected: compile error — no `ConfigApplied` variant, no `config_version` field.

- [ ] **Step 3: Implement the proto side**

Add to the `Response` enum:

```rust
    ConfigApplied { version: u64 },
```

Add to `Status` (after `version`):

```rust
    /// Monotonic count of applied config reloads this daemon session.
    /// 0 until the first reload. Lets the UI confirm an apply landed.
    #[serde(default)]
    pub config_version: u64,
```

Run: `cargo test -p conduit-proto` — PASS. (Daemon now fails to build; continue.)

- [ ] **Step 4: Write the failing daemon test** (append to `ipc.rs` tests)

```rust
    #[test]
    fn set_config_returns_monotonic_version() {
        let dir = std::env::temp_dir().join(format!("conduit-ver-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("conduit.toml");
        let (tx, rx) = crossbeam_channel::unbounded();
        let gate = std::sync::Arc::new(std::sync::Mutex::new(crate::watch::ReloadGate::new()));
        let counter = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));

        let valid = "[profile.default.keys]\n";
        let r1 = set_config(valid, &path, &tx, &gate, &counter);
        let r2 = set_config(valid, &path, &tx, &gate, &counter);
        match (r1, r2) {
            (
                Response::ConfigApplied { version: v1 },
                Response::ConfigApplied { version: v2 },
            ) => assert!(v2 > v1 && v1 >= 1),
            other => panic!("expected ConfigApplied pair, got {other:?}"),
        }
        // Reload messages carry the same versions.
        let mut versions = vec![];
        while let Ok(msg) = rx.try_recv() {
            if let crate::runloop::Msg::Reload(_, v) = msg {
                versions.push(v);
            }
        }
        assert_eq!(versions.len(), 2);
        assert!(versions[1] > versions[0]);
    }
```

Run: `cargo test -p conduit-daemon set_config_returns_monotonic` — compile error (signatures).

- [ ] **Step 5: Implement the daemon side**

1. `runloop.rs`: change `Reload(CompiledConfig)` → `Reload(CompiledConfig, u64)`. In the runloop state add `let mut config_version: u64 = 0;`. In the reload handler bind `Some(Msg::Reload(cfg, ver)) => { config_version = ver; ... }`. Change `build_status` to accept and set it:

```rust
fn build_status(
    engine: &Engine,
    focus: &Option<FocusInfo>,
    grabbed: &[String],
    config_version: u64,
) -> Status {
    Status {
        active_profile: engine.active_profile_name().to_string(),
        active_layers: engine.active_layer_names().iter().map(|s| s.to_string()).collect(),
        suspended: engine.is_suspended(),
        focus: focus.clone(),
        grabbed_devices: grabbed.to_vec(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        config_version,
    }
}
```

Thread `config_version` into every `build_status`/`push_status` call site (the compiler lists them).

2. `ipc.rs`: add `version: &Arc<AtomicU64>` parameter to `set_config` and thread `Arc<AtomicU64>` through `serve`/`handle_conn`/`dispatch` alongside the existing `gate` parameter. In `set_config`, after validation and the atomic write:

```rust
let v = version.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
let _ = tx.send(Msg::Reload(compiled, v));
Response::ConfigApplied { version: v }
```

3. `watch.rs`: add the same `Arc<AtomicU64>` parameter to `spawn`/`poll_loop`; at line 144:

```rust
let v = version.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
if tx.send(Msg::Reload(compiled, v)).is_err() {
```

4. `lib.rs` (~line 192): create and share the counter:

```rust
let config_version = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
```

Pass clones to `ipc::serve` and `watch::spawn`. Update the fixture construction in `ipc.rs` tests (~line 541) and any `Msg::Reload(_)` pattern matches (`runloop.rs` tests, `watch.rs` tests at 160–180) to the two-field form. Task 2's `set_config_invalid_toml_returns_config_invalid_code` test also gains the fifth argument: pass a fresh `Arc::new(AtomicU64::new(0))`.

- [ ] **Step 6: Run all Rust tests**

Run: `cargo test -p conduit-proto -p conduit-daemon`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/conduit-proto/src/lib.rs crates/conduit-daemon/src
git commit -m "feat(daemon): versioned config apply confirmed via status"
```

---

### Task 4: Tauri shell — structured error payload, versioned set_config

**Files:**
- Modify: `ui/src-tauri/src/lib.rs` (`one_shot` at 33–49, `check_ok` at 52–58, all `#[tauri::command]` fns at 62–171)

**Interfaces:**
- Consumes: `Response::Err { code, message, detail, .. }`, `Response::ConfigApplied`, `ErrorCode::as_str()`.
- Produces: commands reject with `ErrorPayload { code: String, message: String, detail: String }` (serialized object — Task 5 relies on these three exact field names); `set_config` command returns `u64`.

- [ ] **Step 1: Define the payload and conversions** (no UI test harness exists for the Tauri crate; the compiler + Task 5's mocked tests cover this layer)

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    pub detail: String,
}

impl ErrorPayload {
    fn new(code: &str, message: impl Into<String>, detail: impl Into<String>) -> Self {
        ErrorPayload { code: code.into(), message: message.into(), detail: detail.into() }
    }

    fn from_io(context: &str, e: &std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::NotFound => {
                "engine-not-running"
            }
            std::io::ErrorKind::PermissionDenied => "permission-denied",
            _ => "internal",
        };
        ErrorPayload::new(code, context, e.to_string())
    }
}

impl From<conduit_proto::Response> for ErrorPayload {
    fn from(resp: conduit_proto::Response) -> Self {
        match resp {
            conduit_proto::Response::Err { code, message, detail, .. } => {
                ErrorPayload::new(code.as_str(), message, detail)
            }
            other => ErrorPayload::new(
                "internal",
                "unexpected response",
                format!("{other:?}"),
            ),
        }
    }
}
```

- [ ] **Step 2: Convert `one_shot`, `check_ok`, and every command**

`one_shot` returns `Result<Response, ErrorPayload>`; each error site uses `ErrorPayload::from_io("connecting to Conduit's engine", &e)` (connect) / `ErrorPayload::new("internal", "…", e.to_string())` (serde). `check_ok` becomes:

```rust
fn check_ok(resp: Response) -> Result<(), ErrorPayload> {
    match resp {
        Response::Ok => Ok(()),
        other => Err(ErrorPayload::from(other)),
    }
}
```

Every command's error type changes `String` → `ErrorPayload`. `set_config` becomes:

```rust
#[tauri::command]
async fn set_config(toml: String) -> Result<u64, ErrorPayload> {
    match one_shot(&Request::SetConfig { toml })? {
        Response::ConfigApplied { version } => Ok(version),
        Response::Ok => Ok(0), // pre-versioning daemon
        other => Err(ErrorPayload::from(other)),
    }
}
```

- [ ] **Step 3: Verify it builds**

Run: `export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig && cargo build --manifest-path ui/src-tauri/Cargo.toml`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add ui/src-tauri/src/lib.rs
git commit -m "feat(tauri): structured error payload and versioned set_config"
```

---

### Task 5: client.ts — `ConduitError` and normalized calls

**Files:**
- Modify: `ui/src/lib/client.ts`
- Test: `ui/src/lib/client.test.ts` (existing file; mocks `invoke` via `vi.mock("@tauri-apps/api/core")`)

**Interfaces:**
- Consumes: `ErrorPayload` rejections `{ code, message, detail }` from Task 4.
- Produces (later phases depend on these exact names): `type ErrorCode` (the eight kebab-case codes plus `"unknown"`), `class ConduitError extends Error { code: ErrorCode; detail: string }`, `setConfig(toml): Promise<number>`, `Status.config_version: number`. All exported functions throw `ConduitError` exclusively.

- [ ] **Step 1: Write the failing tests** (append to `client.test.ts`)

```typescript
import { ConduitError, setConfig, getStatus } from "./client";

describe("typed errors", () => {
  it("wraps structured payload rejections in ConduitError", async () => {
    mockInvoke.mockRejectedValueOnce({
      code: "config-invalid",
      message: "config rejected",
      detail: "expected ']' at line 3",
    });
    const err = await setConfig("bad").catch((e) => e);
    expect(err).toBeInstanceOf(ConduitError);
    expect(err.code).toBe("config-invalid");
    expect(err.detail).toContain("line 3");
  });

  it("maps unknown rejection shapes to code unknown", async () => {
    mockInvoke.mockRejectedValueOnce("socket exploded");
    const err = await getStatus().catch((e) => e);
    expect(err).toBeInstanceOf(ConduitError);
    expect(err.code).toBe("unknown");
    expect(err.message).toBe("socket exploded");
  });

  it("setConfig resolves with the applied version", async () => {
    mockInvoke.mockResolvedValueOnce(42);
    await expect(setConfig("[profile.default.keys]\n")).resolves.toBe(42);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/lib/client.test.ts`
Expected: FAIL — `ConduitError` not exported.

- [ ] **Step 3: Implement in `client.ts`**

```typescript
export type ErrorCode =
  | "engine-not-running"
  | "permission-denied"
  | "device-missing"
  | "config-invalid"
  | "apply-failed"
  | "malformed-request"
  | "timeout"
  | "internal"
  | "unknown";

const KNOWN_CODES: ReadonlySet<string> = new Set([
  "engine-not-running", "permission-denied", "device-missing",
  "config-invalid", "apply-failed", "malformed-request", "timeout", "internal",
]);

export class ConduitError extends Error {
  code: ErrorCode;
  detail: string;
  constructor(code: ErrorCode, message: string, detail = "") {
    super(message);
    this.name = "ConduitError";
    this.code = code;
    this.detail = detail;
  }
}

function toConduitError(e: unknown): ConduitError {
  if (e instanceof ConduitError) return e;
  if (typeof e === "object" && e !== null && "code" in e && "message" in e) {
    const p = e as { code: string; message: string; detail?: string };
    const code = (KNOWN_CODES.has(p.code) ? p.code : "unknown") as ErrorCode;
    return new ConduitError(code, p.message, p.detail ?? "");
  }
  return new ConduitError("unknown", String(e));
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toConduitError(e);
  }
}
```

Route every exported command through `call` (e.g. `getStatus` → `call<Status>("get_status")`). Change `setConfig`:

```typescript
export async function setConfig(toml: string): Promise<number> {
  return call<number>("set_config", { toml });
}
```

Add to the `Status` interface: `config_version: number;` (Tauri delivers it; old daemons yield 0 via serde default).

- [ ] **Step 4: Run the UI test suite**

Run: `cd ui && npx vitest run`
Expected: PASS — including all pre-existing client tests (they assert resolved values, which are unchanged).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/client.ts ui/src/lib/client.test.ts
git commit -m "feat(ui): ConduitError with stable codes; versioned setConfig"
```

---

### Task 6: error-messages.ts — the plain-language table

**Files:**
- Create: `ui/src/lib/error-messages.ts`
- Test: `ui/src/lib/error-messages.test.ts`

**Interfaces:**
- Consumes: `ConduitError`, `ErrorCode` from Task 5.
- Produces (screens in Phases 2–5 render exclusively from this): `type RecoveryAction = "start-engine" | "open-setup" | "retry" | "copy-report"`, `interface ErrorPresentation { title: string; body: string; action: RecoveryAction | null }`, `function presentError(err: ConduitError): ErrorPresentation`. Raw `err.detail`/`err.message` appear only behind "Show technical details" — never in `title`/`body`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";
import { ConduitError } from "./client";
import { presentError } from "./error-messages";

describe("presentError", () => {
  it("gives engine-not-running a start action and no jargon", () => {
    const p = presentError(
      new ConduitError("engine-not-running", "connect refused", "conduit.sock ECONNREFUSED"),
    );
    expect(p.title).toBe("Conduit's engine isn't running");
    expect(p.action).toBe("start-engine");
    for (const word of ["socket", "daemon", "ECONNREFUSED", ".sock"]) {
      expect(`${p.title} ${p.body}`.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("covers every known code plus unknown with a non-empty presentation", () => {
    const codes = [
      "engine-not-running", "permission-denied", "device-missing",
      "config-invalid", "apply-failed", "malformed-request",
      "timeout", "internal", "unknown",
    ] as const;
    for (const code of codes) {
      const p = presentError(new ConduitError(code, "m", "d"));
      expect(p.title.length, code).toBeGreaterThan(0);
      expect(p.body.length, code).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && npx vitest run src/lib/error-messages.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `error-messages.ts`**

```typescript
import type { ConduitError, ErrorCode } from "./client";

export type RecoveryAction = "start-engine" | "open-setup" | "retry" | "copy-report";

export interface ErrorPresentation {
  title: string;
  body: string;
  action: RecoveryAction | null;
}

const TABLE: Record<ErrorCode, ErrorPresentation> = {
  "engine-not-running": {
    title: "Conduit's engine isn't running",
    body: "Your buttons are back to their normal behavior until it starts again.",
    action: "start-engine",
  },
  "permission-denied": {
    title: "Conduit doesn't have permission to do that",
    body: "A one-time setup step is missing or was rolled back by a system update.",
    action: "open-setup",
  },
  "device-missing": {
    title: "That device isn't connected",
    body: "Plug it back in — its settings are saved and will come right back.",
    action: null,
  },
  "config-invalid": {
    title: "That change couldn't be applied",
    body: "Nothing was saved, so everything still works the way it did before.",
    action: "retry",
  },
  "apply-failed": {
    title: "That didn't stick",
    body: "The change couldn't be saved. Your previous settings are untouched.",
    action: "retry",
  },
  "malformed-request": {
    title: "Something went wrong",
    body: "The app and its engine disagreed. Restarting Conduit usually fixes this.",
    action: "copy-report",
  },
  timeout: {
    title: "That took too long",
    body: "Conduit stopped waiting. It's safe to try again.",
    action: "retry",
  },
  internal: {
    title: "Something went wrong",
    body: "An unexpected problem came up. Trying again is safe.",
    action: "copy-report",
  },
  unknown: {
    title: "Something went wrong",
    body: "An unexpected problem came up. Trying again is safe.",
    action: "copy-report",
  },
};

export function presentError(err: ConduitError): ErrorPresentation {
  return TABLE[err.code] ?? TABLE.unknown;
}
```

- [ ] **Step 4: Run the full UI suite**

Run: `cd ui && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/error-messages.ts ui/src/lib/error-messages.test.ts
git commit -m "feat(ui): plain-language error table keyed by stable codes"
```

---

### Task 7: End-to-end verification of the contract

**Files:**
- Modify: none expected; fixes only if verification fails.

- [ ] **Step 1: Full workspace tests**

Run: `export PKG_CONFIG_PATH=/usr/lib64/pkgconfig:/usr/share/pkgconfig && cargo test --workspace && cd ui && npx vitest run`
Expected: all green.

- [ ] **Step 2: Live smoke test against the running daemon**

Run (daemon must be running; it is on this machine):

```bash
printf '%s\n' '{"type":"set_config","toml":"[profile.default.keys]\n"}' | socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/conduit.sock
printf '%s\n' '{"type":"set_config","toml":"not [ valid"}' | socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/conduit.sock
printf '%s\n' '{"type":"get_status"}' | socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/conduit.sock
```

Expected, in order: `{"type":"config_applied","version":1}` (or higher), `{"type":"err","code":"config-invalid",...}` with a non-empty `detail`, and a status containing `"config_version":` matching the applied version. Note: this rewrites the live config to an empty profile — restore it afterwards with `git -C ~/.config/conduit diff` or re-apply from the UI. If the daemon binary is stale, rebuild and restart first: `cargo build --release -p conduit-daemon && systemctl --user restart conduit.service`.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A && git commit -m "test: phase 1 contract verification fixes"
```

(Skip the commit if nothing changed.)
