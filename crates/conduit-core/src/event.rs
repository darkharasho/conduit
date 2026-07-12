#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct Key(pub u16); // Linux evdev key/button code (input-event-codes.h)

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeyState { Press, Release, Repeat }

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Event {
    pub key: Key,
    pub state: KeyState,
    pub time_us: u64, // monotonic microseconds, supplied by the caller
}
