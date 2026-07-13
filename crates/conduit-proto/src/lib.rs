use serde::{Deserialize, Serialize};

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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct FocusInfo {
    pub process: String,
    pub class: String,
    pub title: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    GetStatus,
    GetConfig,
    SetConfig { toml: String },
    ListDevices,
    SubscribeEvents,
    SubscribeStatus,
    Suspend,
    Resume,
    ListWindows,
    CaptureNextKey,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Response {
    Status(Status),
    Config { toml: String },
    Ok,
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
    Devices { devices: Vec<DeviceInfo> },
    Windows { windows: Vec<FocusInfo> },
    CapturedKey { name: String, code: u16 },
    Subscribed,
}

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

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Status {
    pub active_profile: String,
    pub active_layers: Vec<String>,
    pub suspended: bool,
    pub focus: Option<FocusInfo>,
    pub grabbed_devices: Vec<String>,
    pub version: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DeviceInfo {
    pub path: String,
    pub name: String,
    pub vendor: u16,
    pub product: u16,
    pub is_keyboard: bool,
    pub is_mouse: bool,
    pub grabbed: bool,
    /// Canonical selector: `vid:pid/name`.
    #[serde(default)]
    pub id: String,
    /// Device class: keyboard | mouse | touchpad | gamepad | media | other.
    #[serde(default)]
    pub class: String,
    /// Physical topology path (e.g. `usb-0000:00:14.0-1/input0`), often empty.
    #[serde(default)]
    pub phys: String,
    /// EV_KEY codes this device declares (sorted). The UI renders only
    /// controls that actually exist on the device.
    #[serde(default)]
    pub keys: Vec<u16>,
    /// Declares REL_WHEEL (vertical scroll).
    #[serde(default)]
    pub wheel: bool,
    /// Declares REL_HWHEEL (horizontal scroll).
    #[serde(default)]
    pub hwheel: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Push {
    Event(WireEvent),
    Status(Status),
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WireEvent {
    pub phase: EventPhase,
    pub key_name: String,
    pub code: u16,
    pub state: String,
    pub time_us: u64,
    /// Source device name (pre-phase events only; empty on post-phase).
    #[serde(default)]
    pub device: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum EventPhase {
    Pre,
    Post,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_request_set_config_round_trip() {
        let original = Request::SetConfig {
            toml: "x".to_string(),
        };
        let json = serde_json::to_string(&original).expect("serialize");
        let deserialized: Request = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(original, deserialized);
    }

    #[test]
    fn test_push_event_round_trip() {
        let original = Push::Event(WireEvent {
            phase: EventPhase::Pre,
            key_name: "Enter".to_string(),
            code: 28,
            state: "press".to_string(),
            time_us: 1234567890,
            device: "Test Kbd".to_string(),
        });
        let json = serde_json::to_string(&original).expect("serialize");
        let deserialized: Push = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(original, deserialized);
    }

    #[test]
    fn wire_shapes_are_stable() {
        assert_eq!(
            serde_json::to_string(&Request::GetStatus).unwrap(),
            r#"{"type":"get_status"}"#
        );
        assert_eq!(
            serde_json::to_string(&Response::Ok).unwrap(),
            r#"{"type":"ok"}"#
        );
        let devs = Response::Devices {
            devices: vec![],
        };
        assert_eq!(
            serde_json::to_string(&devs).unwrap(),
            r#"{"type":"devices","devices":[]}"#
        );
        let one = Response::Devices {
            devices: vec![DeviceInfo {
                path: "/dev/input/event0".into(),
                name: "G600".into(),
                vendor: 0x046d,
                product: 0xc24a,
                is_keyboard: false,
                is_mouse: true,
                grabbed: true,
                id: "046d:c24a/G600".into(),
                class: "mouse".into(),
                phys: "usb-0000:00:14.0-1/input0".into(),
                keys: vec![0x110, 0x111],
                wheel: true,
                hwheel: false,
            }],
        };
        let json = serde_json::to_string(&one).unwrap();
        assert!(json.contains("\"id\":\"046d:c24a/G600\""));
        assert!(json.contains("\"class\":\"mouse\""));
        assert!(json.contains("\"phys\":\"usb-0000:00:14.0-1/input0\""));
        let wins = Response::Windows {
            windows: vec![],
        };
        assert_eq!(
            serde_json::to_string(&wins).unwrap(),
            r#"{"type":"windows","windows":[]}"#
        );
        let ev = Push::Event(WireEvent {
            phase: EventPhase::Pre,
            key_name: "a".into(),
            code: 30,
            state: "press".into(),
            time_us: 5,
            device: "".into(),
        });
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"type":"event","phase":"pre","key_name":"a","code":30,"state":"press","time_us":5,"device":""}"#
        );
    }

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
}
