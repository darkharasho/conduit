import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---- Error types ----

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
  "engine-not-running",
  "permission-denied",
  "device-missing",
  "config-invalid",
  "apply-failed",
  "malformed-request",
  "timeout",
  "internal",
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

async function call<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  try {
    return args !== undefined
      ? await invoke<T>(cmd, args)
      : await invoke<T>(cmd);
  } catch (e) {
    throw toConduitError(e);
  }
}

// ---- TypeScript interfaces mirroring proto JSON shapes (snake_case) ----

export interface FocusInfo {
  process: string;
  class: string;
  title: string;
}

export interface Status {
  active_profile: string;
  active_layers: string[];
  suspended: boolean;
  focus: FocusInfo | null;
  grabbed_devices: string[];
  version: string;
  /** Applied config version counter; old daemons yield 0 via serde default */
  config_version: number;
}

export interface DeviceInfo {
  path: string;
  name: string;
  vendor: number;
  product: number;
  is_keyboard: boolean;
  is_mouse: boolean;
  grabbed: boolean;
  /** Canonical selector: `vid:pid/name` */
  id: string;
  /** keyboard | mouse | touchpad | gamepad | media | other */
  class: string;
  phys: string;
  /** EV_KEY codes this device declares (sorted) */
  keys: number[];
  /** Declares REL_WHEEL / REL_HWHEEL */
  wheel: boolean;
  hwheel: boolean;
}

export interface WireEvent {
  phase: "pre" | "post";
  key_name: string;
  code: number;
  state: string;
  time_us: number;
  /** Source device name (pre-phase events only; empty on post-phase) */
  device: string;
}

export interface CapturedKey {
  name: string;
  code: number;
}

// ---- One-shot command wrappers ----

export async function getStatus(): Promise<Status> {
  return call<Status>("get_status");
}

export async function getConfig(): Promise<string> {
  return call<string>("get_config");
}

export async function setConfig(toml: string): Promise<number> {
  return call<number>("set_config", { toml });
}

export async function listDevices(): Promise<DeviceInfo[]> {
  return call<DeviceInfo[]>("list_devices");
}

export async function listWindows(): Promise<FocusInfo[]> {
  return call<FocusInfo[]>("list_windows");
}

export async function suspend(): Promise<void> {
  return call<void>("suspend");
}

export async function resume(): Promise<void> {
  return call<void>("resume");
}

export async function captureNextKey(): Promise<CapturedKey> {
  return call<CapturedKey>("capture_next_key");
}

export interface InstalledApp {
  app_id: string;
  name: string;
  wm_class: string | null;
  categories: string[];
  icon: string | null;
}

export async function listInstalledApps(): Promise<InstalledApp[]> {
  return call<InstalledApp[]>("list_installed_apps");
}

export interface SetupStatus {
  service_installed: boolean;
  service_running: boolean;
  daemon_connected: boolean;
  uinput_ok: boolean;
  evdev_ok: boolean;
  input_group: boolean;
  config_ok: boolean;
  binary_missing: boolean;
  binary_path: string | null;
  details: string[];
  /** Version reported by the running daemon; null when the socket is unreachable. */
  daemon_version: string | null;
  /** This app build's own version. */
  app_version: string;
}

export interface PermissionFixOutcome {
  relogin_needed: boolean;
}

export async function setupStatus(): Promise<SetupStatus> {
  return call<SetupStatus>("setup_status");
}

export async function setupInstallService(): Promise<void> {
  return call<void>("setup_install_service");
}

export async function setupFixPermissions(): Promise<PermissionFixOutcome> {
  return call<PermissionFixOutcome>("setup_fix_permissions");
}

export async function restartEngine(): Promise<void> {
  return call<void>("restart_engine");
}

export async function collectReport(): Promise<string> {
  return call<string>("collect_report");
}

// ---- Ratbag / onboard-profile types ----

export interface RatbagStatus {
  daemon_running: boolean;
  device_id: string | null;
  device_name: string | null;
}

export interface OnboardButton {
  index: number;
  action: string;
}

export interface OnboardButtonDto {
  index: number;
  action: string;
  human: string;
}

// ---- Ratbag commands ----

/** Stage the patched G502 X device file to a temp dir; returns the temp path. */
export async function ratbagStageDeviceFile(): Promise<string> {
  return call<string>("ratbag_stage_device_file");
}

/** Query ratbagd daemon status and G502 X device presence. */
export async function ratbagGetStatus(): Promise<RatbagStatus> {
  return call<RatbagStatus>("ratbag_status");
}

/** Read the current onboard button map for a device. */
export async function ratbagReadButtons(
  deviceId: string
): Promise<OnboardButtonDto[]> {
  return call<OnboardButtonDto[]>("ratbag_read_buttons", {
    deviceId,
  });
}

/** Run the one-prompt pkexec setup: copy device data, install drop-in, restart ratbagd. */
export async function ratbagFixSetup(
  patchedDeviceTempPath: string
): Promise<void> {
  return call<void>("ratbag_fix_setup", { patchedDeviceTempPath });
}

/** Compute the suggested collision-fix rewrite targets from a button map. */
export async function ratbagSuggestRewrites(
  buttons: OnboardButton[]
): Promise<[number, string][]> {
  return call<[number, string][]>("ratbag_suggest_rewrites", { buttons });
}

/** Rewrite button mappings on the device (sequential ratbagctl calls). */
export async function ratbagRewrite(
  deviceId: string,
  targets: [number, string][]
): Promise<void> {
  return call<void>("ratbag_rewrite", { deviceId, targets });
}

// ---- Subscription event listeners ----

/** Subscribe to live Status push events from the daemon */
export function onStatus(
  cb: (status: Status) => void
): Promise<() => void> {
  return listen<Status>("conduit://status", (event) => cb(event.payload));
}

/** Subscribe to key events from the daemon */
export function onKeyEvent(
  cb: (event: WireEvent) => void
): Promise<() => void> {
  return listen<WireEvent>("conduit://event", (event) => cb(event.payload));
}

/** Subscribe to daemon connection state changes */
export function onConnection(
  cb: (connected: boolean) => void
): Promise<[() => void, () => void]> {
  const connectedP = listen<null>("conduit://connected", () => cb(true));
  const disconnectedP = listen<null>("conduit://disconnected", () => cb(false));
  return Promise.all([connectedP, disconnectedP]);
}
