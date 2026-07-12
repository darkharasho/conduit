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
    Devices(Vec<DeviceInfo>),
    Windows(Vec<FocusInfo>),
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
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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
        });
        let json = serde_json::to_string(&original).expect("serialize");
        let deserialized: Push = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(original, deserialized);
    }
}
