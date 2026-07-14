use indexmap::IndexMap;
use serde::Deserialize;
use crate::{event::Key, keys};

pub const KEY_TABLE_SIZE: usize = 768;

pub const MAX_CHORD_KEYS: usize = 4;

/// A fixed-capacity multi-key output (e.g. Ctrl+C). Kept `Copy` so `Action`
/// stays `Copy` for the engine's lookup tables.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Chord {
    keys: [Key; MAX_CHORD_KEYS],
    len: u8,
}

impl Chord {
    pub fn new(keys: &[Key]) -> Option<Chord> {
        if keys.len() < 2 || keys.len() > MAX_CHORD_KEYS {
            return None;
        }
        let mut arr = [Key(0); MAX_CHORD_KEYS];
        arr[..keys.len()].copy_from_slice(keys);
        Some(Chord { keys: arr, len: keys.len() as u8 })
    }

    pub fn keys(&self) -> &[Key] {
        &self.keys[..self.len as usize]
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum HoldAction {
    Key(Key),
    Layer(u8),
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Action {
    Key(Key),
    TapHold { tap: Key, hold: HoldAction, timeout_us: u64 },
    LayerWhileHeld(u8),
    LayerToggle(u8),
    Disabled,
    Passthrough,
    Chord(Chord),
}

pub type LayerMap = Box<[Option<Action>; KEY_TABLE_SIZE]>;

pub struct FocusFields<'a> {
    pub process: &'a str,
    pub class: &'a str,
    pub title: &'a str,
}

pub struct Matcher {
    pub process: Option<String>,
    pub class: Option<String>,
    pub title: Option<regex::Regex>,
}

impl Matcher {
    pub fn matches(&self, f: &FocusFields) -> bool {
        let ok = |pat: &Option<String>, val: &str| {
            pat.as_ref().map_or(true, |p| p.eq_ignore_ascii_case(val))
        };
        ok(&self.process, f.process)
            && ok(&self.class, f.class)
            && self.title.as_ref().map_or(true, |re| re.is_match(f.title))
    }
}

pub struct CompiledProfile {
    pub name: String,
    pub matcher: Option<Matcher>,
    /// When false the profile is "paused" and will never be auto-selected by
    /// `set_focus`. It can still be activated by an explicit UI selection.
    /// Defaults to true; set via `auto_switch = false` in the TOML.
    pub auto_switch: bool,
    pub layers: Vec<LayerMap>,
    pub layer_names: Vec<String>,
    /// Per-device shadow tables, outer-indexed by the global device slot
    /// (`CompiledConfig::device_selectors`); `None` = this profile has no
    /// section for that selector. Inner Vec is indexed like `layers`.
    pub device_layers: Vec<Option<Vec<LayerMap>>>,
}

impl std::fmt::Debug for CompiledProfile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CompiledProfile")
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone)]
pub struct Settings {
    pub tap_hold_timeout_us: u64,
    pub panic_chord: Vec<Key>,
    pub grab_all_keyboards: bool,
    pub grab_all_mice: bool,
    pub grab_keyboards: Vec<String>,
    pub grab_mice: Vec<String>,
}

#[derive(Debug)]
pub struct CompiledConfig {
    pub settings: Settings,
    pub profiles: Vec<CompiledProfile>,
    pub default_idx: usize,
    /// Union of device selector strings across all profiles, first-seen
    /// order. The index of a selector here is its **device slot** — the
    /// daemon resolves each grabbed device to a slot and stamps its events.
    pub device_selectors: Vec<String>,
}

// ── Error type ────────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("TOML parse error: {0}")]
    Toml(String),
    #[error("unknown key `{name}` in profile `{profile}`")]
    UnknownKey { profile: String, name: String },
    #[error("unknown layer `{name}` in profile `{profile}`")]
    UnknownLayer { profile: String, name: String },
    #[error("unknown inherit target `{from}` in profile `{profile}`")]
    UnknownInherit { profile: String, from: String },
    #[error("inherit cycle involving profile `{0}`")]
    InheritCycle(String),
    #[error("panic chord unreachable in profile `{profile}`")]
    PanicChordUnreachable { profile: String },
    #[error("profile '{profile}': invalid title regex: {message}")]
    InvalidRegex { profile: String, message: String },
    #[error("profile '{0}' has no match rule; only 'default' may omit match")]
    NoMatcher(String),
    #[error("config is empty: no default profile and no keys")]
    Empty,
    #[error("chord `{chord}` in profile `{profile}` must have 2 to 4 keys")]
    BadChord { profile: String, chord: String },
}

// ── Raw serde layer ──────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct RawConfig {
    #[serde(default)]
    settings: RawSettings,
    #[serde(default)]
    devices: RawDevices,
    #[serde(default)]
    profile: IndexMap<String, RawProfile>,
}

#[derive(Deserialize, Default)]
struct RawSettings {
    tap_hold_timeout: Option<u64>, // milliseconds
    #[serde(default)]
    panic_chord: Vec<String>,
}

#[derive(Deserialize, Default)]
struct RawDevices {
    #[serde(default)]
    grab_all_keyboards: bool,
    #[serde(default)]
    grab_all_mice: bool,
    #[serde(default)]
    grab_keyboards: Vec<String>,
    #[serde(default)]
    grab_mice: Vec<String>,
}

#[derive(Deserialize, Default)]
struct RawProfile {
    #[serde(rename = "match")]
    r#match: Option<RawMatch>,
    inherit: Option<String>,
    #[serde(default)]
    auto_switch: Option<bool>,
    #[serde(default)]
    keys: IndexMap<String, RawAction>,
    #[serde(default)]
    layers: IndexMap<String, IndexMap<String, RawAction>>,
    /// Per-device override sections, keyed by device selector string.
    #[serde(default)]
    device: IndexMap<String, RawDeviceOverride>,
}

#[derive(Deserialize, Default)]
struct RawDeviceOverride {
    #[serde(default)]
    keys: IndexMap<String, RawAction>,
    #[serde(default)]
    layers: IndexMap<String, IndexMap<String, RawAction>>,
}

#[derive(Deserialize)]
struct RawMatch {
    process: Option<String>,
    class: Option<String>,
    title: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawAction {
    Str(String),
    TapHold {
        tap: String,
        hold: String,
        timeout_ms: Option<u64>,
    },
}

// ── Compile entry point ───────────────────────────────────────────────────────

pub fn compile(toml_str: &str) -> Result<CompiledConfig, ConfigError> {
    // Step 1: parse TOML
    let raw: RawConfig = toml::from_str(toml_str)
        .map_err(|e| ConfigError::Toml(e.to_string()))?;

    // Step 2: resolve settings
    let tap_hold_timeout_us = raw.settings.tap_hold_timeout.unwrap_or(200) * 1000;

    let panic_chord: Vec<Key> = if raw.settings.panic_chord.is_empty() {
        // default panic chord
        vec![
            keys::from_name("leftctrl").unwrap(),
            keys::from_name("leftalt").unwrap(),
            keys::from_name("backspace").unwrap(),
        ]
    } else {
        raw.settings
            .panic_chord
            .iter()
            .map(|n| {
                let key = keys::from_name(n).ok_or_else(|| ConfigError::UnknownKey {
                    profile: "settings".to_string(),
                    name: n.clone(),
                })?;
                // Bounds check panic_chord keys
                if key.0 as usize >= KEY_TABLE_SIZE {
                    return Err(ConfigError::UnknownKey {
                        profile: "settings".to_string(),
                        name: n.clone(),
                    });
                }
                Ok(key)
            })
            .collect::<Result<Vec<_>, _>>()?
    };

    let settings = Settings {
        tap_hold_timeout_us,
        panic_chord: panic_chord.clone(),
        grab_all_keyboards: raw.devices.grab_all_keyboards,
        grab_all_mice: raw.devices.grab_all_mice,
        grab_keyboards: raw.devices.grab_keyboards,
        grab_mice: raw.devices.grab_mice,
    };

    // Step 3: ensure "default" profile exists
    let mut profiles = raw.profile;
    if !profiles.contains_key("default") {
        profiles.insert("default".to_string(), RawProfile::default());
    }

    // Step 4: compile all profiles, resolving inheritance with DFS
    // We need to compile in dependency order.
    let profile_names: Vec<String> = profiles.keys().cloned().collect();

    // compiled_map: name -> CompiledProfile (layers + layer_names)
    let mut compiled_map: IndexMap<String, (Vec<LayerMap>, Vec<String>)> = IndexMap::new();

    // We compile profiles on demand with cycle detection.
    // visiting: profiles currently in the DFS stack
    let mut visiting: std::collections::HashSet<String> = std::collections::HashSet::new();

    fn compile_profile_layers(
        name: &str,
        profiles: &IndexMap<String, RawProfile>,
        compiled_map: &mut IndexMap<String, (Vec<LayerMap>, Vec<String>)>,
        visiting: &mut std::collections::HashSet<String>,
        settings_timeout_us: u64,
    ) -> Result<(), ConfigError> {
        if compiled_map.contains_key(name) {
            return Ok(());
        }
        if visiting.contains(name) {
            return Err(ConfigError::InheritCycle(name.to_string()));
        }
        visiting.insert(name.to_string());

        let raw_profile = profiles.get(name).ok_or_else(|| ConfigError::UnknownInherit {
            profile: name.to_string(),
            from: name.to_string(),
        })?;

        // First, resolve inheritance
        let (mut layers, mut layer_names): (Vec<LayerMap>, Vec<String>) =
            if let Some(parent_name) = &raw_profile.inherit {
                // Check parent exists
                if !profiles.contains_key(parent_name.as_str()) {
                    return Err(ConfigError::UnknownInherit {
                        profile: name.to_string(),
                        from: parent_name.clone(),
                    });
                }
                // Recursively compile parent first
                compile_profile_layers(
                    parent_name,
                    profiles,
                    compiled_map,
                    visiting,
                    settings_timeout_us,
                )?;
                // Deep-clone parent's layers
                let (parent_layers, parent_layer_names) =
                    compiled_map.get(parent_name.as_str()).unwrap();
                let cloned_layers: Vec<LayerMap> = parent_layers
                    .iter()
                    .map(|lm| {
                        let mut new_lm: Box<[Option<Action>; KEY_TABLE_SIZE]> =
                            Box::new([None; KEY_TABLE_SIZE]);
                        new_lm.copy_from_slice(lm.as_ref());
                        new_lm
                    })
                    .collect();
                (cloned_layers, parent_layer_names.clone())
            } else {
                // Start fresh: just a base layer
                let base: LayerMap = Box::new([None; KEY_TABLE_SIZE]);
                (vec![base], vec!["base".to_string()])
            };

        // Collect all layer names defined in this profile (for reference resolution)
        // We need to know all layer names BEFORE compiling actions so "layer:X" refs work.
        // First pass: register new layer names.
        for layer_name in raw_profile.layers.keys() {
            if !layer_names.contains(layer_name) {
                layer_names.push(layer_name.clone());
                layers.push(Box::new([None; KEY_TABLE_SIZE]));
            }
        }

        // Compile base-layer keys
        for (key_name, raw_action) in &raw_profile.keys {
            let key = parse_key_checked(key_name, name)?;
            let action = compile_raw_action(raw_action, name, &layer_names, settings_timeout_us)?;
            layers[0][key.0 as usize] = Some(action);
        }

        // Compile named layers
        for (layer_name, layer_keys) in &raw_profile.layers {
            // guaranteed to exist (registered above)
            let layer_idx = layer_names.iter().position(|n| n == layer_name).unwrap();
            for (key_name, raw_action) in layer_keys {
                let key = parse_key_checked(key_name, name)?;
                let action =
                    compile_raw_action(raw_action, name, &layer_names, settings_timeout_us)?;
                layers[layer_idx][key.0 as usize] = Some(action);
            }
        }

        visiting.remove(name);
        compiled_map.insert(name.to_string(), (layers, layer_names));
        Ok(())
    }

    // Compile all profiles
    for pname in &profile_names {
        compile_profile_layers(
            pname,
            &profiles,
            &mut compiled_map,
            &mut visiting,
            tap_hold_timeout_us,
        )?;
    }

    // Step 5: Build CompiledProfile list
    // Order: non-default profiles in file order, default last
    let mut compiled_profiles: Vec<CompiledProfile> = Vec::new();

    for pname in &profile_names {
        if pname == "default" {
            continue;
        }
        let raw_profile = profiles.get(pname).unwrap();
        // Non-default profiles must have a match block
        if raw_profile.r#match.is_none() {
            return Err(ConfigError::NoMatcher(pname.clone()));
        }
        let matcher = build_matcher(raw_profile, pname)?;
        let auto_switch = raw_profile.auto_switch.unwrap_or(true);
        let (layers, layer_names) = compiled_map.shift_remove(pname).unwrap();
        compiled_profiles.push(CompiledProfile {
            name: pname.clone(),
            matcher,
            auto_switch,
            layers,
            layer_names,
            device_layers: Vec::new(),
        });
    }

    // Append default last
    {
        let raw_default = profiles.get("default").unwrap();
        let matcher = build_matcher(raw_default, "default")?;
        let (layers, layer_names) = compiled_map.shift_remove("default").unwrap();
        compiled_profiles.push(CompiledProfile {
            name: "default".to_string(),
            matcher,
            auto_switch: true, // default profile is never paused
            layers,
            layer_names,
            device_layers: Vec::new(),
        });
    }

    let default_idx = compiled_profiles.len() - 1;

    // Step 5b: compile device override sections.
    // Slot indices are global: the union of selector strings across profiles.
    let mut device_selectors: Vec<String> = Vec::new();
    for raw_profile in profiles.values() {
        for sel in raw_profile.device.keys() {
            if !device_selectors.iter().any(|s| s == sel) {
                device_selectors.push(sel.clone());
            }
        }
    }
    for compiled in compiled_profiles.iter_mut() {
        let raw_profile = profiles.get(compiled.name.as_str()).unwrap();
        let mut dev_layers: Vec<Option<Vec<LayerMap>>> = vec![None; device_selectors.len()];
        for (sel, ovr) in &raw_profile.device {
            let slot = device_selectors.iter().position(|s| s == sel).unwrap();
            let mut tables: Vec<LayerMap> =
                (0..compiled.layer_names.len()).map(|_| new_layer_map()).collect();
            let ctx = format!("{}.device.{}", compiled.name, sel);
            for (key_name, raw_action) in &ovr.keys {
                let key = parse_key_checked(key_name, &ctx)?;
                let action =
                    compile_raw_action(raw_action, &ctx, &compiled.layer_names, tap_hold_timeout_us)?;
                tables[0][key.0 as usize] = Some(action);
            }
            for (layer_name, layer_keys) in &ovr.layers {
                let li = compiled
                    .layer_names
                    .iter()
                    .position(|n| n == layer_name)
                    .ok_or_else(|| ConfigError::UnknownLayer {
                        profile: ctx.clone(),
                        name: layer_name.clone(),
                    })?;
                for (key_name, raw_action) in layer_keys {
                    let key = parse_key_checked(key_name, &ctx)?;
                    let action = compile_raw_action(
                        raw_action,
                        &ctx,
                        &compiled.layer_names,
                        tap_hold_timeout_us,
                    )?;
                    tables[li][key.0 as usize] = Some(action);
                }
            }
            dev_layers[slot] = Some(tables);
        }
        compiled.device_layers = dev_layers;
    }

    // Step 6: Panic-chord validation
    for cp in &compiled_profiles {
        let all_blocked = panic_chord.iter().all(|chord_key| {
            // Bounds check: should never happen here since panic_chord was already checked,
            // but be defensive
            if chord_key.0 as usize >= KEY_TABLE_SIZE {
                return false;
            }
            match cp.layers[0][chord_key.0 as usize] {
                Some(Action::Passthrough) | None => false,
                Some(_) => true,
            }
        });
        if all_blocked {
            return Err(ConfigError::PanicChordUnreachable {
                profile: cp.name.clone(),
            });
        }
    }

    Ok(CompiledConfig {
        settings,
        profiles: compiled_profiles,
        default_idx,
        device_selectors,
    })
}

fn new_layer_map() -> LayerMap {
    Box::new([None; KEY_TABLE_SIZE])
}

/// Parse a key name and bounds-check it against `KEY_TABLE_SIZE`.
/// `ctx` is the profile (or `profile.device.selector`) name used in errors.
fn parse_key_checked(name: &str, ctx: &str) -> Result<Key, ConfigError> {
    let key = keys::from_name(name).ok_or_else(|| ConfigError::UnknownKey {
        profile: ctx.to_string(),
        name: name.to_string(),
    })?;
    if key.0 as usize >= KEY_TABLE_SIZE {
        return Err(ConfigError::UnknownKey {
            profile: ctx.to_string(),
            name: name.to_string(),
        });
    }
    Ok(key)
}

/// Compile one raw action (string or tap-hold) with `layer:X` references
/// resolved against `layer_names`. Shared by global and device sections.
fn compile_raw_action(
    raw: &RawAction,
    ctx: &str,
    layer_names: &[String],
    default_timeout_us: u64,
) -> Result<Action, ConfigError> {
    let layer_index = |lname: &str| layer_names.iter().position(|n| n == lname);
    match raw {
        RawAction::Str(s) => match s.as_str() {
            "disabled" => Ok(Action::Disabled),
            "passthrough" => Ok(Action::Passthrough),
            s if s.starts_with("layer:") => {
                let lname = &s[6..];
                layer_index(lname)
                    .map(|i| Action::LayerToggle(i as u8))
                    .ok_or_else(|| ConfigError::UnknownLayer {
                        profile: ctx.to_string(),
                        name: lname.to_string(),
                    })
            }
            s if s.contains('+') => {
                let toks: Vec<&str> =
                    s.split('+').filter(|t| !t.is_empty()).collect();
                let mut parsed = Vec::with_capacity(toks.len());
                for t in &toks {
                    parsed.push(parse_key_checked(t, ctx)?);
                }
                Chord::new(&parsed)
                    .map(Action::Chord)
                    .ok_or_else(|| ConfigError::BadChord {
                        profile: ctx.to_string(),
                        chord: s.to_string(),
                    })
            }
            s => Ok(Action::Key(parse_key_checked(s, ctx)?)),
        },
        RawAction::TapHold { tap, hold, timeout_ms } => {
            let tap_key = parse_key_checked(tap, ctx)?;
            let hold_action = if let Some(lname) = hold.strip_prefix("layer:") {
                let idx = layer_index(lname).ok_or_else(|| ConfigError::UnknownLayer {
                    profile: ctx.to_string(),
                    name: lname.to_string(),
                })?;
                HoldAction::Layer(idx as u8)
            } else {
                HoldAction::Key(parse_key_checked(hold, ctx)?)
            };
            let timeout_us = timeout_ms.unwrap_or(default_timeout_us / 1000) * 1000;
            Ok(Action::TapHold { tap: tap_key, hold: hold_action, timeout_us })
        }
    }
}

fn build_matcher(raw_profile: &RawProfile, profile_name: &str) -> Result<Option<Matcher>, ConfigError> {
    match &raw_profile.r#match {
        None => Ok(None),
        Some(rm) => {
            let title_re = rm
                .title
                .as_ref()
                .map(|t| regex::Regex::new(t))
                .transpose()
                .map_err(|e| ConfigError::InvalidRegex {
                    profile: profile_name.to_string(),
                    message: e.to_string(),
                })?;
            Ok(Some(Matcher {
                process: rm.process.clone(),
                class: rm.class.clone(),
                title: title_re,
            }))
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{event::Key, keys};

    const SPEC_TOML: &str = r#"
        [settings]
        tap_hold_timeout = 200
        panic_chord = ["leftctrl", "leftalt", "backspace"]

        [devices]
        grab_all_keyboards = true
        grab_mice = ["Logitech G502"]

        [profile.default.keys]
        capslock = { tap = "esc", hold = "leftctrl" }
        f = { tap = "f", hold = "layer:nav" }

        [profile.default.layers.nav]
        h = "left"
        j = "down"
        k = "up"
        l = "right"

        [profile.firefox]
        match = { class = "firefox" }
        inherit = "default"
        keys = { mouse4 = "back" }
    "#;

    fn key(n: &str) -> Key { keys::from_name(n).unwrap() }

    #[test]
    fn compiles_spec_example() {
        let c = compile(SPEC_TOML).unwrap();
        assert_eq!(c.profiles.len(), 2);
        let def = &c.profiles[c.default_idx];
        assert_eq!(def.name, "default");
        match def.layers[0][key("capslock").0 as usize] {
            Some(Action::TapHold { tap, hold: HoldAction::Key(h), timeout_us }) => {
                assert_eq!(tap, key("esc"));
                assert_eq!(h, key("leftctrl"));
                assert_eq!(timeout_us, 200_000);
            }
            other => panic!("wrong action: {other:?}"),
        }
        // nav layer is index 1; h -> left
        assert_eq!(def.layers[1][key("h").0 as usize], Some(Action::Key(key("left"))));
    }

    #[test]
    fn firefox_inherits_and_overlays() {
        let c = compile(SPEC_TOML).unwrap();
        let ff = c.profiles.iter().find(|p| p.name == "firefox").unwrap();
        // inherited tap-hold still present
        assert!(matches!(ff.layers[0][key("capslock").0 as usize], Some(Action::TapHold { .. })));
        // overlay applied
        assert_eq!(ff.layers[0][key("mouse4").0 as usize], Some(Action::Key(key("back"))));
        // matcher works
        assert!(ff.matcher.as_ref().unwrap().matches(&FocusFields { process: "firefox-bin", class: "firefox", title: "x" }));
        assert!(!ff.matcher.as_ref().unwrap().matches(&FocusFields { process: "kitty", class: "kitty", title: "x" }));
    }

    #[test]
    fn unknown_key_rejected() {
        let err = compile("[profile.default.keys]\nnotakey = \"esc\"").unwrap_err();
        assert!(matches!(err, ConfigError::UnknownKey { .. }));
    }

    #[test]
    fn unknown_layer_rejected() {
        let err = compile("[profile.default.keys]\nf = { tap = \"f\", hold = \"layer:nope\" }").unwrap_err();
        assert!(matches!(err, ConfigError::UnknownLayer { .. }));
    }

    #[test]
    fn panic_chord_must_stay_reachable() {
        let toml = r#"
            [profile.default.keys]
            leftctrl = "a"
            leftalt = "b"
            backspace = "c"
        "#;
        assert!(matches!(compile(toml).unwrap_err(), ConfigError::PanicChordUnreachable { .. }));
    }

    #[test]
    fn empty_config_gets_default_profile() {
        let c = compile("").unwrap();
        assert_eq!(c.profiles[c.default_idx].name, "default");
    }

    #[test]
    fn oob_key_code_768_rejected_as_input() {
        let err = compile("[profile.default.keys]\n\"key:768\" = \"esc\"").unwrap_err();
        assert!(matches!(err, ConfigError::UnknownKey { .. }));
    }

    #[test]
    fn oob_key_code_900_rejected_as_output() {
        let err = compile("[profile.default.keys]\na = \"key:900\"").unwrap_err();
        assert!(matches!(err, ConfigError::UnknownKey { .. }));
    }

    #[test]
    fn oob_panic_chord_rejected() {
        let err = compile("[settings]\npanic_chord = [\"key:800\"]").unwrap_err();
        assert!(matches!(err, ConfigError::UnknownKey { .. }));
    }

    #[test]
    fn invalid_regex_in_match_title() {
        let err = compile("[profile.test]\nmatch = { title = \"(\" }\n[profile.test.keys]\na = \"esc\"").unwrap_err();
        assert!(matches!(err, ConfigError::InvalidRegex { .. }));
    }

    #[test]
    fn non_default_profile_without_match_rejected() {
        let err = compile("[profile.foo]\n[profile.foo.keys]\na = \"esc\"").unwrap_err();
        assert!(matches!(err, ConfigError::NoMatcher(_)));
    }

    #[test]
    fn default_profile_without_match_allowed() {
        let c = compile("[profile.default.keys]\na = \"esc\"").unwrap();
        assert_eq!(c.profiles[c.default_idx].name, "default");
        assert!(c.profiles[c.default_idx].matcher.is_none());
    }

    #[test]
    fn grab_all_mice_parses_and_defaults_false() {
        let s = compile("[devices]\ngrab_all_mice = true").unwrap().settings;
        assert!(s.grab_all_mice);
        let s = compile("[profile.default.keys]\na = \"b\"").unwrap().settings;
        assert!(!s.grab_all_mice);
    }

    // ── Device override sections ───────────────────────────────────────────────

    const DEV_TOML: &str = r#"
        [profile.default.keys]
        a = "b"
        [profile.default.layers.nav]
        h = "left"
        [profile.default.device."046d:c24a/G600".keys]
        btn_left = "enter"
        [profile.default.device."046d:c24a/G600".layers.nav]
        mouse4 = "volumeup"
        [profile.game]
        match = { class = "steam" }
        [profile.game.device."My Kbd".keys]
        a = "passthrough"
    "#;

    #[test]
    fn device_sections_compile_with_global_slots() {
        let c = compile(DEV_TOML).unwrap();
        assert_eq!(
            c.device_selectors,
            vec!["046d:c24a/G600".to_string(), "My Kbd".to_string()]
        );
        let def = &c.profiles[c.default_idx];
        let g600 = def.device_layers[0].as_ref().expect("default has G600 section");
        assert_eq!(g600.len(), def.layer_names.len());
        let btn_left = keys::from_name("btn_left").unwrap();
        assert_eq!(
            g600[0][btn_left.0 as usize],
            Some(Action::Key(keys::from_name("enter").unwrap()))
        );
        let nav_idx = def.layer_names.iter().position(|n| n == "nav").unwrap();
        let mouse4 = keys::from_name("mouse4").unwrap();
        assert_eq!(
            g600[nav_idx][mouse4.0 as usize],
            Some(Action::Key(keys::from_name("volumeup").unwrap()))
        );
        assert!(def.device_layers[1].is_none()); // default has no "My Kbd" section
        let game = c.profiles.iter().find(|p| p.name == "game").unwrap();
        assert!(game.device_layers[0].is_none());
        assert!(game.device_layers[1].is_some());
    }

    #[test]
    fn device_section_unknown_layer_rejected() {
        let err = compile("[profile.default.device.\"X\".layers.nope]\na = \"b\"").unwrap_err();
        assert!(matches!(err, ConfigError::UnknownLayer { .. }));
    }

    #[test]
    fn device_section_unknown_key_rejected() {
        let err = compile("[profile.default.device.\"X\".keys]\nnotakey = \"b\"").unwrap_err();
        assert!(matches!(err, ConfigError::UnknownKey { .. }));
    }

    #[test]
    fn device_section_taphold_and_layer_refs_compile() {
        let toml = r#"
            [profile.default.layers.nav]
            h = "left"
            [profile.default.device."g".keys]
            f = { tap = "f", hold = "layer:nav" }
            space = "layer:nav"
        "#;
        let c = compile(toml).unwrap();
        let def = &c.profiles[c.default_idx];
        let dev = def.device_layers[0].as_ref().unwrap();
        let f = keys::from_name("f").unwrap();
        assert!(matches!(dev[0][f.0 as usize], Some(Action::TapHold { .. })));
        let space = keys::from_name("space").unwrap();
        assert!(matches!(dev[0][space.0 as usize], Some(Action::LayerToggle(_))));
    }

    #[test]
    fn no_device_sections_yields_empty_selectors() {
        let c = compile("[profile.default.keys]\na = \"b\"").unwrap();
        assert!(c.device_selectors.is_empty());
        assert!(c.profiles[c.default_idx].device_layers.is_empty());
    }

    #[test]
    fn chord_string_compiles_to_chord_action() {
        let cfg = compile("[profile.default.keys]\nmouse4 = \"ctrl+c\"\n").unwrap();
        let def = &cfg.profiles[cfg.default_idx];
        match def.layers[0][keys::from_name("mouse4").unwrap().0 as usize] {
            Some(Action::Chord(ch)) => {
                let ks = ch.keys();
                assert_eq!(ks.len(), 2);
                assert_eq!(ks[0], keys::from_name("leftctrl").unwrap()); // alias resolved
                assert_eq!(ks[1], keys::from_name("c").unwrap());
            }
            other => panic!("expected Chord, got {other:?}"),
        }
    }

    #[test]
    fn chord_rejects_bad_shapes() {
        // 5 keys: too long
        let e = compile("[profile.default.keys]\na = \"ctrl+shift+alt+meta+c\"\n").unwrap_err();
        assert!(matches!(e, ConfigError::BadChord { .. }), "got {e:?}");
        // unknown token inside a chord
        let e = compile("[profile.default.keys]\na = \"ctrl+notakey\"\n").unwrap_err();
        assert!(matches!(e, ConfigError::UnknownKey { .. }), "got {e:?}");
        // trailing separator produces one real token → not a valid chord
        let e = compile("[profile.default.keys]\na = \"c+\"\n").unwrap_err();
        assert!(matches!(e, ConfigError::BadChord { .. }), "got {e:?}");
    }

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
}
