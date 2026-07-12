/**
 * config-model.ts
 *
 * UI-side representation of the Conduit config.  The daemon owns parse and
 * validation; we just edit the JS object and round-trip through TOML.
 *
 * SIMPLIFICATION (documented): getAction() does NOT auto-resolve inheritance.
 * The UI shows each profile's own keys only.  To see inherited keys the user
 * selects the parent profile.  This matches how Karabiner-Elements works.
 *
 * The "base" layer corresponds to the profile's [profile.<name>.keys] table.
 * Named layers are in [profile.<name>.layers.<layerName>].
 */

import { parse, stringify } from "smol-toml";

// ── Action model ──────────────────────────────────────────────────────────────

export type ActionModel =
  | { kind: "key"; key: string }
  | { kind: "taphold"; tap: string; hold: string; timeoutMs?: number }
  | { kind: "layer_toggle"; layer: string }
  | { kind: "disabled" }
  | { kind: "passthrough" };

// ── Config model ──────────────────────────────────────────────────────────────

export interface ProfileModel {
  /** Profile name (map key) */
  name: string;
  /** Match rule (class / process / title) */
  match?: Record<string, string>;
  /** Parent profile to inherit from */
  inherit?: string;
  /** Base-layer key mappings (profile.keys table) */
  keys: Record<string, RawActionModel>;
  /** Named layers: layerName → keyName → action */
  layers: Record<string, Record<string, RawActionModel>>;
}

/** Raw action as stored in TOML — either a plain string or a tap-hold object */
type RawActionModel =
  | string
  | { tap: string; hold: string; timeout_ms?: number };

export interface ConfigModel {
  /** Non-profile settings */
  settings: Record<string, unknown>;
  /** Device settings */
  devices: Record<string, unknown>;
  /** Profiles in insertion order */
  profiles: ProfileModel[];
  /** Raw parsed TOML top-level object (used for re-serialization of unknown keys) */
  _raw: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function actionToRaw(action: ActionModel): RawActionModel {
  switch (action.kind) {
    case "key":
      return action.key;
    case "disabled":
      return "disabled";
    case "passthrough":
      return "passthrough";
    case "layer_toggle":
      return `layer:${action.layer}`;
    case "taphold": {
      const obj: { tap: string; hold: string; timeout_ms?: number } = {
        tap: action.tap,
        hold: action.hold,
      };
      if (action.timeoutMs !== undefined) obj.timeout_ms = action.timeoutMs;
      return obj;
    }
  }
}

function rawToAction(raw: RawActionModel): ActionModel {
  if (typeof raw === "string") {
    if (raw === "disabled") return { kind: "disabled" };
    if (raw === "passthrough") return { kind: "passthrough" };
    if (raw.startsWith("layer:")) {
      return { kind: "layer_toggle", layer: raw.slice(6) };
    }
    return { kind: "key", key: raw };
  }
  // tap-hold object
  const action: ActionModel = {
    kind: "taphold",
    tap: raw.tap,
    hold: raw.hold,
  };
  if (raw.timeout_ms !== undefined) {
    (action as { kind: "taphold"; tap: string; hold: string; timeoutMs?: number }).timeoutMs =
      raw.timeout_ms;
  }
  return action;
}

// ── Parse ─────────────────────────────────────────────────────────────────────

export function parseConfigToml(toml: string): ConfigModel {
  const raw = parse(toml) as Record<string, unknown>;

  const settings = (raw["settings"] as Record<string, unknown> | undefined) ?? {};
  const devices = (raw["devices"] as Record<string, unknown> | undefined) ?? {};
  const rawProfiles = (raw["profile"] as Record<string, unknown> | undefined) ?? {};

  const profiles: ProfileModel[] = Object.entries(rawProfiles).map(([name, rawProf]) => {
    const rp = rawProf as Record<string, unknown>;

    const match = rp["match"] as Record<string, string> | undefined;
    const inherit = rp["inherit"] as string | undefined;
    const rawKeys = (rp["keys"] as Record<string, RawActionModel> | undefined) ?? {};
    const rawLayers =
      (rp["layers"] as Record<string, Record<string, RawActionModel>> | undefined) ?? {};

    return {
      name,
      match,
      inherit,
      keys: { ...rawKeys },
      layers: Object.fromEntries(
        Object.entries(rawLayers).map(([lname, lkeys]) => [lname, { ...lkeys }])
      ),
    };
  });

  return { settings, devices, profiles, _raw: raw };
}

// ── Serialize ─────────────────────────────────────────────────────────────────

export function serializeConfigToml(m: ConfigModel): string {
  // Rebuild the raw TOML object from the model, preserving other top-level keys.
  const out: Record<string, unknown> = {
    ...m._raw,
    settings: m.settings,
    devices: m.devices,
  };

  // Rebuild the profile map preserving order
  const profileMap: Record<string, unknown> = {};
  for (const prof of m.profiles) {
    const entry: Record<string, unknown> = {};
    if (prof.match !== undefined) entry["match"] = prof.match;
    if (prof.inherit !== undefined) entry["inherit"] = prof.inherit;
    if (Object.keys(prof.keys).length > 0) entry["keys"] = prof.keys;
    if (Object.keys(prof.layers).length > 0) entry["layers"] = prof.layers;
    profileMap[prof.name] = entry;
  }

  if (Object.keys(profileMap).length > 0) {
    out["profile"] = profileMap;
  } else {
    delete out["profile"];
  }

  return stringify(out);
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export function listProfiles(m: ConfigModel): string[] {
  return m.profiles.map((p) => p.name);
}

export function listLayers(m: ConfigModel, profileName: string): string[] {
  const prof = m.profiles.find((p) => p.name === profileName);
  if (!prof) return ["base"];
  return ["base", ...Object.keys(prof.layers)];
}

export function getAction(
  m: ConfigModel,
  profileName: string,
  layer: string,
  keyName: string
): ActionModel | null {
  const prof = m.profiles.find((p) => p.name === profileName);
  if (!prof) return null;

  let raw: RawActionModel | undefined;
  if (layer === "base") {
    raw = prof.keys[keyName];
  } else {
    raw = prof.layers[layer]?.[keyName];
  }

  if (raw === undefined) return null;
  return rawToAction(raw);
}

export function setAction(
  m: ConfigModel,
  profileName: string,
  layer: string,
  keyName: string,
  action: ActionModel
): ConfigModel {
  // Find or create the profile
  const profIdx = m.profiles.findIndex((p) => p.name === profileName);
  if (profIdx === -1) {
    throw new Error(`Profile "${profileName}" not found`);
  }

  // Deep-clone the profiles array immutably
  const profiles = m.profiles.map((p, i) => {
    if (i !== profIdx) return p;
    // Clone this profile
    const clonedProf: ProfileModel = {
      ...p,
      keys: { ...p.keys },
      layers: Object.fromEntries(
        Object.entries(p.layers).map(([k, v]) => [k, { ...v }])
      ),
    };

    const raw = actionToRaw(action);
    if (layer === "base") {
      clonedProf.keys[keyName] = raw;
    } else {
      // Create layer if it doesn't exist
      if (!clonedProf.layers[layer]) {
        clonedProf.layers[layer] = {};
      }
      clonedProf.layers[layer][keyName] = raw;
    }

    return clonedProf;
  });

  return { ...m, profiles };
}

export function addProfile(
  m: ConfigModel,
  name: string,
  matchClass: string
): ConfigModel {
  // Avoid duplicates
  if (m.profiles.some((p) => p.name === name)) return m;

  const newProf: ProfileModel = {
    name,
    match: { class: matchClass },
    inherit: "default",
    keys: {},
    layers: {},
  };

  return { ...m, profiles: [...m.profiles, newProf] };
}

export function addLayer(
  m: ConfigModel,
  profileName: string,
  layerName: string
): ConfigModel {
  const profIdx = m.profiles.findIndex((p) => p.name === profileName);
  if (profIdx === -1) return m;

  const profiles = m.profiles.map((p, i) => {
    if (i !== profIdx) return p;
    if (p.layers[layerName]) return p; // already exists
    return {
      ...p,
      layers: { ...p.layers, [layerName]: {} },
    };
  });

  return { ...m, profiles };
}

// ── Device grab accessors ─────────────────────────────────────────────────────

export interface DeviceGrabs {
  grabAllKeyboards: boolean;
  grabKeyboards: string[];
  grabMice: string[];
}

/** Read the device grab settings from the model. */
export function getDeviceGrabs(m: ConfigModel): DeviceGrabs {
  const d = m.devices;
  const grabAllKeyboards = (d["grab_all_keyboards"] as boolean | undefined) ?? false;
  const grabKeyboards = (d["grab_keyboards"] as string[] | undefined) ?? [];
  const grabMice = (d["grab_mice"] as string[] | undefined) ?? [];
  return { grabAllKeyboards, grabKeyboards, grabMice };
}

/**
 * Toggle a keyboard's grab state.
 *
 * If `grab_all_keyboards` is true and `grabbed=false`:
 *   - set grab_all_keyboards = false
 *   - set grab_keyboards = currentlyGrabbedKeyboards minus name
 *
 * If `grab_all_keyboards` is true and `grabbed=true`:
 *   - no change (already grabbing all)
 *
 * If `grab_all_keyboards` is false:
 *   - add/remove name from grab_keyboards (idempotent)
 */
export function setKeyboardGrab(
  m: ConfigModel,
  name: string,
  grabbed: boolean,
  currentlyGrabbedKeyboards: string[]
): ConfigModel {
  const d = { ...m.devices };
  const grabAll = (d["grab_all_keyboards"] as boolean | undefined) ?? false;

  if (grabAll) {
    if (!grabbed) {
      // Convert grab_all → explicit list, minus this device
      const explicit = currentlyGrabbedKeyboards.filter((k) => k !== name);
      d["grab_all_keyboards"] = false;
      d["grab_keyboards"] = explicit;
    }
    // grabbed=true when grab_all=true: no-op (all keyboards already grabbed)
  } else {
    // Explicit list mode
    const current = (d["grab_keyboards"] as string[] | undefined) ?? [];
    if (grabbed) {
      // Add idempotently
      if (!current.includes(name)) {
        d["grab_keyboards"] = [...current, name];
      } else {
        d["grab_keyboards"] = [...current];
      }
    } else {
      // Remove
      d["grab_keyboards"] = current.filter((k) => k !== name);
    }
  }

  return { ...m, devices: d };
}

/**
 * Toggle a mouse's grab state.
 * Adds/removes name from grab_mice (idempotent).
 */
export function setMouseGrab(
  m: ConfigModel,
  name: string,
  grabbed: boolean
): ConfigModel {
  const d = { ...m.devices };
  const current = (d["grab_mice"] as string[] | undefined) ?? [];

  if (grabbed) {
    d["grab_mice"] = current.includes(name) ? [...current] : [...current, name];
  } else {
    d["grab_mice"] = current.filter((n) => n !== name);
  }

  return { ...m, devices: d };
}

// ── Presentation helpers (pure, no side effects) ──────────────────────────────

/**
 * Returns a short human-readable match rule label for display in the rail,
 * e.g. `class:firefox` or `process:code`.
 * Returns null for the default profile (no match rule).
 */
export function getProfileMatchLabel(
  m: ConfigModel,
  profileName: string
): string | null {
  const prof = m.profiles.find((p) => p.name === profileName);
  if (!prof || !prof.match) return null;
  const entries = Object.entries(prof.match);
  if (entries.length === 0) return null;
  // Prefer class, then process, then title, then first available
  const preferred = ["class", "process", "title"];
  const entry =
    preferred.map((k) => entries.find(([ek]) => ek === k)).find(Boolean) ??
    entries[0];
  return `${entry[0]}:${entry[1]}`;
}

/**
 * Renders the exact TOML assignment line that would be written to conduit.toml
 * for a given key action.
 *
 * Examples:
 *   `conduit.toml → [profile.default.keys] capslock = { tap = "esc", hold = "leftctrl" }`
 *   `conduit.toml → [profile.default.layers.nav] h = "left"`
 */
export function actionToTomlLine(
  profileName: string,
  layer: string,
  keyName: string,
  action: ActionModel
): string {
  const section =
    layer === "base"
      ? `profile.${profileName}.keys`
      : `profile.${profileName}.layers.${layer}`;

  let valueStr: string;
  switch (action.kind) {
    case "key":
      valueStr = `"${action.key}"`;
      break;
    case "disabled":
      valueStr = `"disabled"`;
      break;
    case "passthrough":
      valueStr = `"passthrough"`;
      break;
    case "layer_toggle":
      valueStr = `"layer:${action.layer}"`;
      break;
    case "taphold": {
      const parts = [`tap = "${action.tap}"`, `hold = "${action.hold}"`];
      if (action.timeoutMs !== undefined) {
        parts.push(`timeout_ms = ${action.timeoutMs}`);
      }
      valueStr = `{ ${parts.join(", ")} }`;
      break;
    }
  }

  return `conduit.toml → [${section}] ${keyName} = ${valueStr}`;
}
