import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
}

export interface DeviceInfo {
  path: string;
  name: string;
  vendor: number;
  product: number;
  is_keyboard: boolean;
  is_mouse: boolean;
  grabbed: boolean;
}

export interface WireEvent {
  phase: "pre" | "post";
  key_name: string;
  code: number;
  state: string;
  time_us: number;
}

export interface CapturedKey {
  name: string;
  code: number;
}

// ---- One-shot command wrappers ----

export async function getStatus(): Promise<Status> {
  return invoke<Status>("get_status");
}

export async function getConfig(): Promise<string> {
  return invoke<string>("get_config");
}

export async function setConfig(toml: string): Promise<void> {
  return invoke<void>("set_config", { toml });
}

export async function listDevices(): Promise<DeviceInfo[]> {
  return invoke<DeviceInfo[]>("list_devices");
}

export async function listWindows(): Promise<FocusInfo[]> {
  return invoke<FocusInfo[]>("list_windows");
}

export async function suspend(): Promise<void> {
  return invoke<void>("suspend");
}

export async function resume(): Promise<void> {
  return invoke<void>("resume");
}

export async function captureNextKey(): Promise<CapturedKey> {
  return invoke<CapturedKey>("capture_next_key");
}

export interface SetupResult {
  daemon: boolean;
  uinput: boolean;
  input_group: boolean;
  config_ok: boolean;
}

export async function checkSetup(): Promise<SetupResult> {
  return invoke<SetupResult>("check_setup");
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
