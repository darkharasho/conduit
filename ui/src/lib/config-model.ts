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
  /** Per-device override sections, keyed by device selector string */
  device?: Record<string, DeviceOverrideModel>;
}

export interface DeviceOverrideModel {
  keys: Record<string, RawActionModel>;
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
    const rawDevice = rp["device"] as
      | Record<string, { keys?: Record<string, RawActionModel>; layers?: Record<string, Record<string, RawActionModel>> }>
      | undefined;

    const device = rawDevice
      ? Object.fromEntries(
          Object.entries(rawDevice).map(([sel, ovr]) => [
            sel,
            {
              keys: { ...(ovr.keys ?? {}) },
              layers: Object.fromEntries(
                Object.entries(ovr.layers ?? {}).map(([ln, lk]) => [ln, { ...lk }])
              ),
            },
          ])
        )
      : undefined;

    return {
      name,
      match,
      inherit,
      keys: { ...rawKeys },
      layers: Object.fromEntries(
        Object.entries(rawLayers).map(([lname, lkeys]) => [lname, { ...lkeys }])
      ),
      device,
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
    if (prof.device !== undefined && Object.keys(prof.device).length > 0) {
      entry["device"] = Object.fromEntries(
        Object.entries(prof.device).map(([sel, ovr]) => {
          const o: Record<string, unknown> = {};
          if (Object.keys(ovr.keys).length > 0) o["keys"] = ovr.keys;
          if (Object.keys(ovr.layers).length > 0) o["layers"] = ovr.layers;
          return [sel, o];
        })
      );
    }
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
  grabAllMice: boolean;
  grabKeyboards: string[];
  grabMice: string[];
}

/** Read the device grab settings from the model. */
export function getDeviceGrabs(m: ConfigModel): DeviceGrabs {
  const d = m.devices;
  const grabAllKeyboards = (d["grab_all_keyboards"] as boolean | undefined) ?? false;
  const grabAllMice = (d["grab_all_mice"] as boolean | undefined) ?? false;
  const grabKeyboards = (d["grab_keyboards"] as string[] | undefined) ?? [];
  const grabMice = (d["grab_mice"] as string[] | undefined) ?? [];
  return { grabAllKeyboards, grabAllMice, grabKeyboards, grabMice };
}

// ── Device selectors ──────────────────────────────────────────────────────────

/** Identity fields a selector can match against (subset of DeviceInfo). */
export interface DeviceIdent {
  name: string;
  vendor: number;
  product: number;
  /** Physical port path; only consulted by `@phys`-suffixed selectors. */
  phys?: string;
}

function parseVidPid(s: string): [number, number] | null {
  const m = /^([0-9a-fA-F]{4}):([0-9a-fA-F]{4})$/.exec(s);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16)];
}

type ParsedSelector = {
  kind: "name" | "vidpid" | "vidpidname";
  name?: string;
  vendor?: number;
  product?: number;
  phys?: string;
};

/**
 * Mirror of the daemon's DeviceSelector grammar:
 * name | vid:pid | vid:pid/name, each optionally suffixed with `@phys`
 * (recognized only when the prefix parses as vid:pid or vid:pid/name).
 */
function parseSelector(entry: string): ParsedSelector {
  const at = entry.lastIndexOf("@");
  if (at > 0) {
    const prefix = entry.slice(0, at);
    const base = parseSelectorBase(prefix);
    if (base.kind !== "name") {
      return { ...base, phys: entry.slice(at + 1) };
    }
  }
  return parseSelectorBase(entry);
}

function parseSelectorBase(s: string): ParsedSelector {
  const slash = s.indexOf("/");
  if (slash > 0) {
    const vp = parseVidPid(s.slice(0, slash));
    if (vp) {
      return { kind: "vidpidname", vendor: vp[0], product: vp[1], name: s.slice(slash + 1) };
    }
  }
  const vp = parseVidPid(s);
  if (vp) return { kind: "vidpid", vendor: vp[0], product: vp[1] };
  return { kind: "name", name: s };
}

export function selectorMatches(entry: string, dev: DeviceIdent): boolean {
  const sel = parseSelector(entry);
  const baseOk =
    sel.kind === "name"
      ? sel.name === dev.name
      : sel.kind === "vidpid"
        ? sel.vendor === dev.vendor && sel.product === dev.product
        : sel.vendor === dev.vendor && sel.product === dev.product && sel.name === dev.name;
  return baseOk && (sel.phys === undefined || sel.phys === (dev.phys ?? ""));
}

/** 4 = vid:pid/name@phys, 3 = vid:pid/name, 2 = name, 1 = vid:pid (mirrors daemon). */
export function selectorSpecificity(entry: string): number {
  const sel = parseSelector(entry);
  if (sel.phys !== undefined) return 4;
  if (sel.kind === "vidpidname") return 3;
  if (sel.kind === "name") return 2;
  return 1;
}

export function listMatchesDevice(list: string[], dev: DeviceIdent): boolean {
  return list.some((e) => selectorMatches(e, dev));
}

// ── Per-device override accessors ─────────────────────────────────────────────

/**
 * The existing device section key that best matches `dev` in this profile
 * (highest specificity; ties → first in section order), or null.
 */
export function deviceSectionFor(
  m: ConfigModel,
  profileName: string,
  dev: DeviceIdent
): string | null {
  const prof = m.profiles.find((p) => p.name === profileName);
  if (!prof?.device) return null;
  let best: string | null = null;
  let bestSpec = 0;
  for (const sel of Object.keys(prof.device)) {
    if (!selectorMatches(sel, dev)) continue;
    const spec = selectorSpecificity(sel);
    if (spec > bestSpec) {
      best = sel;
      bestSpec = spec;
    }
  }
  return best;
}

/**
 * Section key the UI should WRITE for this device: the canonical
 * `vid:pid/name`, `@phys`-suffixed only when another listed device shares
 * the canonical id (twin devices).
 */
export function deviceSectionKey(
  dev: DeviceIdent & { id: string; phys?: string },
  allDevices: Array<{ id: string; phys?: string }>
): string {
  const twins = allDevices.filter((d) => d.id === dev.id);
  if (twins.length > 1 && dev.phys) {
    return `${dev.id}@${dev.phys}`;
  }
  return dev.id;
}

/**
 * Effective action for a key as seen by `dev`: its device section shadows
 * the profile's own tables; absent everywhere → null. `dev: null` = no
 * device context (profile tables only).
 */
export function getEffectiveAction(
  m: ConfigModel,
  profileName: string,
  dev: DeviceIdent | null,
  layer: string,
  keyName: string
): { action: ActionModel; source: "device" | "profile" } | null {
  if (dev) {
    const section = deviceSectionFor(m, profileName, dev);
    if (section) {
      const prof = m.profiles.find((p) => p.name === profileName)!;
      const ovr = prof.device![section];
      const raw = layer === "base" ? ovr.keys[keyName] : ovr.layers[layer]?.[keyName];
      if (raw !== undefined) {
        return { action: rawToAction(raw), source: "device" };
      }
    }
  }
  const global = getAction(m, profileName, layer, keyName);
  return global ? { action: global, source: "profile" } : null;
}

/** Write a device-scoped mapping, creating the section/layer as needed. */
export function setDeviceAction(
  m: ConfigModel,
  profileName: string,
  sectionKey: string,
  layer: string,
  keyName: string,
  action: ActionModel
): ConfigModel {
  const profIdx = m.profiles.findIndex((p) => p.name === profileName);
  if (profIdx === -1) throw new Error(`Profile "${profileName}" not found`);

  const profiles = m.profiles.map((p, i) => {
    if (i !== profIdx) return p;
    const device = { ...(p.device ?? {}) };
    const ovr: DeviceOverrideModel = device[sectionKey]
      ? {
          keys: { ...device[sectionKey].keys },
          layers: Object.fromEntries(
            Object.entries(device[sectionKey].layers).map(([k, v]) => [k, { ...v }])
          ),
        }
      : { keys: {}, layers: {} };
    const raw = actionToRaw(action);
    if (layer === "base") {
      ovr.keys[keyName] = raw;
    } else {
      ovr.layers[layer] = { ...(ovr.layers[layer] ?? {}), [keyName]: raw };
    }
    device[sectionKey] = ovr;
    return { ...p, device };
  });

  return { ...m, profiles };
}

/** Delete a device-scoped mapping; prunes empty layers/sections/maps. */
export function removeDeviceAction(
  m: ConfigModel,
  profileName: string,
  sectionKey: string,
  layer: string,
  keyName: string
): ConfigModel {
  const profIdx = m.profiles.findIndex((p) => p.name === profileName);
  if (profIdx === -1) return m;

  const profiles = m.profiles.map((p, i) => {
    if (i !== profIdx || !p.device?.[sectionKey]) return p;
    const device = { ...p.device };
    const ovr: DeviceOverrideModel = {
      keys: { ...device[sectionKey].keys },
      layers: Object.fromEntries(
        Object.entries(device[sectionKey].layers).map(([k, v]) => [k, { ...v }])
      ),
    };
    if (layer === "base") {
      delete ovr.keys[keyName];
    } else if (ovr.layers[layer]) {
      delete ovr.layers[layer][keyName];
      if (Object.keys(ovr.layers[layer]).length === 0) delete ovr.layers[layer];
    }
    if (Object.keys(ovr.keys).length === 0 && Object.keys(ovr.layers).length === 0) {
      delete device[sectionKey];
    } else {
      device[sectionKey] = ovr;
    }
    const next: ProfileModel = { ...p, device };
    if (Object.keys(device).length === 0) delete next.device;
    return next;
  });

  return { ...m, profiles };
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
  dev: DeviceIdent & { id: string },
  grabbed: boolean,
  currentlyGrabbedKeyboardIds: string[]
): ConfigModel {
  const d = { ...m.devices };
  const grabAll = (d["grab_all_keyboards"] as boolean | undefined) ?? false;

  if (grabAll) {
    if (!grabbed) {
      // Convert grab_all → explicit list, minus this device
      const explicit = currentlyGrabbedKeyboardIds.filter((k) => k !== dev.id);
      d["grab_all_keyboards"] = false;
      d["grab_keyboards"] = explicit;
    }
    // grabbed=true when grab_all=true: no-op (all keyboards already grabbed)
  } else {
    // Explicit list mode. Additions write the canonical `vid:pid/name` id;
    // removals drop any selector form matching the device.
    const current = (d["grab_keyboards"] as string[] | undefined) ?? [];
    if (grabbed) {
      d["grab_keyboards"] = listMatchesDevice(current, dev) ? [...current] : [...current, dev.id];
    } else {
      d["grab_keyboards"] = current.filter((e) => !selectorMatches(e, dev));
    }
  }

  return { ...m, devices: d };
}

/**
 * Toggle a mouse's (or touchpad's) grab state. Additions write the canonical
 * `vid:pid/name` id; removals drop any selector form matching the device.
 */
export function setMouseGrab(
  m: ConfigModel,
  dev: DeviceIdent & { id: string },
  grabbed: boolean
): ConfigModel {
  const d = { ...m.devices };
  const current = (d["grab_mice"] as string[] | undefined) ?? [];

  if (grabbed) {
    d["grab_mice"] = listMatchesDevice(current, dev) ? [...current] : [...current, dev.id];
  } else {
    d["grab_mice"] = current.filter((e) => !selectorMatches(e, dev));
  }

  return { ...m, devices: d };
}

/** Set `devices.grab_all_mice` (touchpads are never included by the daemon). */
export function setGrabAllMice(m: ConfigModel, on: boolean): ConfigModel {
  return { ...m, devices: { ...m.devices, grab_all_mice: on } };
}

/**
 * Replace a profile's match rule. Empty-string values are dropped; an empty
 * result removes the match table entirely. Unknown profile → unchanged model.
 */
export function setProfileMatch(
  m: ConfigModel,
  profileName: string,
  match: Record<string, string> | undefined
): ConfigModel {
  const profIdx = m.profiles.findIndex((p) => p.name === profileName);
  if (profIdx === -1) return m;
  const cleaned = Object.fromEntries(
    Object.entries(match ?? {}).filter(([, v]) => v.trim() !== "")
  );
  const next = Object.keys(cleaned).length > 0 ? cleaned : undefined;
  const profiles = m.profiles.map((p, i) => (i === profIdx ? { ...p, match: next } : p));
  return { ...m, profiles };
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
