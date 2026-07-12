use serde::{Deserialize, Serialize};

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
    Err { message: String },
    Devices { devices: Vec<DeviceInfo> },
    Windows { windows: Vec<FocusInfo> },
    CapturedKey { name: String, code: u16 },
    Subscribed,
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
}
