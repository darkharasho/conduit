use indexmap::IndexMap;
use serde::Deserialize;
use crate::{event::Key, keys};

pub const KEY_TABLE_SIZE: usize = 768;

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
    pub layers: Vec<LayerMap>,
    pub layer_names: Vec<String>,
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

        // Helper: resolve a layer name to index
        let layer_index = |lname: &str| -> Option<usize> {
            layer_names.iter().position(|n| n == lname)
        };

        // Helper: parse an action string
        let parse_action_str = |s: &str, profile_name: &str| -> Result<Action, ConfigError> {
            match s {
                "disabled" => Ok(Action::Disabled),
                "passthrough" => Ok(Action::Passthrough),
                s if s.starts_with("layer:") => {
                    let lname = &s[6..];
                    layer_index(lname)
                        .map(|i| Action::LayerToggle(i as u8))
                        .ok_or_else(|| ConfigError::UnknownLayer {
                            profile: profile_name.to_string(),
                            name: lname.to_string(),
                        })
                }
                s => {
                    let key = keys::from_name(s)
                        .ok_or_else(|| ConfigError::UnknownKey {
                            profile: profile_name.to_string(),
                            name: s.to_string(),
                        })?;
                    // Bounds check for output keys
                    if key.0 as usize >= KEY_TABLE_SIZE {
                        return Err(ConfigError::UnknownKey {
                            profile: profile_name.to_string(),
                            name: s.to_string(),
                        });
                    }
                    Ok(Action::Key(key))
                }
            }
        };

        // Compile base-layer keys
        for (key_name, raw_action) in &raw_profile.keys {
            let key = keys::from_name(key_name).ok_or_else(|| ConfigError::UnknownKey {
                profile: name.to_string(),
                name: key_name.clone(),
            })?;
            // Bounds check for input key
            if key.0 as usize >= KEY_TABLE_SIZE {
                return Err(ConfigError::UnknownKey {
                    profile: name.to_string(),
                    name: key_name.clone(),
                });
            }
            let action = match raw_action {
                RawAction::Str(s) => parse_action_str(s, name)?,
                RawAction::TapHold { tap, hold, timeout_ms } => {
                    let tap_key = keys::from_name(tap).ok_or_else(|| ConfigError::UnknownKey {
                        profile: name.to_string(),
                        name: tap.clone(),
                    })?;
                    // Bounds check for output key (tap)
                    if tap_key.0 as usize >= KEY_TABLE_SIZE {
                        return Err(ConfigError::UnknownKey {
                            profile: name.to_string(),
                            name: tap.clone(),
                        });
                    }
                    let hold_action = if hold.starts_with("layer:") {
                        let lname = &hold[6..];
                        let idx = layer_index(lname).ok_or_else(|| ConfigError::UnknownLayer {
                            profile: name.to_string(),
                            name: lname.to_string(),
                        })?;
                        HoldAction::Layer(idx as u8)
                    } else {
                        let hold_key = keys::from_name(hold).ok_or_else(|| ConfigError::UnknownKey {
                            profile: name.to_string(),
                            name: hold.clone(),
                        })?;
                        // Bounds check for output key (hold)
                        if hold_key.0 as usize >= KEY_TABLE_SIZE {
                            return Err(ConfigError::UnknownKey {
                                profile: name.to_string(),
                                name: hold.clone(),
                            });
                        }
                        HoldAction::Key(hold_key)
                    };
                    let timeout_us = timeout_ms.unwrap_or(settings_timeout_us / 1000) * 1000;
                    Action::TapHold {
                        tap: tap_key,
                        hold: hold_action,
                        timeout_us,
                    }
                }
            };
            layers[0][key.0 as usize] = Some(action);
        }

        // Compile named layers
        for (layer_name, layer_keys) in &raw_profile.layers {
            let layer_idx = layer_index(layer_name).unwrap(); // guaranteed to exist (registered above)
            for (key_name, raw_action) in layer_keys {
                let key = keys::from_name(key_name).ok_or_else(|| ConfigError::UnknownKey {
                    profile: name.to_string(),
                    name: key_name.clone(),
                })?;
                // Bounds check for input key
                if key.0 as usize >= KEY_TABLE_SIZE {
                    return Err(ConfigError::UnknownKey {
                        profile: name.to_string(),
                        name: key_name.clone(),
                    });
                }
                let action = match raw_action {
                    RawAction::Str(s) => parse_action_str(s, name)?,
                    RawAction::TapHold { tap, hold, timeout_ms } => {
                        let tap_key = keys::from_name(tap).ok_or_else(|| ConfigError::UnknownKey {
                            profile: name.to_string(),
                            name: tap.clone(),
                        })?;
                        // Bounds check for output key (tap)
                        if tap_key.0 as usize >= KEY_TABLE_SIZE {
                            return Err(ConfigError::UnknownKey {
                                profile: name.to_string(),
                                name: tap.clone(),
                            });
                        }
                        let hold_action = if hold.starts_with("layer:") {
                            let lname = &hold[6..];
                            let idx = layer_index(lname).ok_or_else(|| ConfigError::UnknownLayer {
                                profile: name.to_string(),
                                name: lname.to_string(),
                            })?;
                            HoldAction::Layer(idx as u8)
                        } else {
                            let hold_key = keys::from_name(hold).ok_or_else(|| ConfigError::UnknownKey {
                                profile: name.to_string(),
                                name: hold.clone(),
                            })?;
                            // Bounds check for output key (hold)
                            if hold_key.0 as usize >= KEY_TABLE_SIZE {
                                return Err(ConfigError::UnknownKey {
                                    profile: name.to_string(),
                                    name: hold.clone(),
                                });
                            }
                            HoldAction::Key(hold_key)
                        };
                        let timeout_us = timeout_ms.unwrap_or(settings_timeout_us / 1000) * 1000;
                        Action::TapHold {
                            tap: tap_key,
                            hold: hold_action,
                            timeout_us,
                        }
                    }
                };
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
        let (layers, layer_names) = compiled_map.shift_remove(pname).unwrap();
        compiled_profiles.push(CompiledProfile {
            name: pname.clone(),
            matcher,
            layers,
            layer_names,
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
            layers,
            layer_names,
        });
    }

    let default_idx = compiled_profiles.len() - 1;

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
    })
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
}
