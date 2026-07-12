//! Virtual output devices for Conduit — a uinput keyboard and a uinput mouse.
//!
//! `VirtualOutput` wraps two `evdev::uinput::VirtualDevice` instances:
//!
//! - **Conduit Virtual Keyboard**: exposes all key codes 1..=767 except the
//!   mouse-button range (0x110..=0x117), and has *no* EV_REP capability so
//!   the compositor/libinput handles repeat itself.
//! - **Conduit Virtual Mouse**: exposes BTN_LEFT..=BTN_TASK plus EV_REL axes
//!   (REL_X, REL_Y, REL_WHEEL, REL_HWHEEL) so the compositor recognises it
//!   as a pointer device.
//!
//! # SYN_REPORT
//! `evdev::uinput::VirtualDevice::emit(&[InputEvent])` already appends a
//! `SYN_REPORT` automatically (see the evdev source); we do not add one
//! ourselves.

use anyhow::Context;
use evdev::{
    uinput::VirtualDeviceBuilder, AttributeSet, EventType, InputEvent, Key, RelativeAxisType,
};

use conduit_core::event::{Event, KeyState};
use conduit_core::keys::is_mouse_button;

/// Holds the two virtual uinput devices through which Conduit injects events.
pub struct VirtualOutput {
    keyboard: evdev::uinput::VirtualDevice,
    mouse: evdev::uinput::VirtualDevice,
}

impl VirtualOutput {
    /// Create both virtual devices.
    ///
    /// Requires write access to `/dev/uinput` (typically via the `input` group
    /// or a udev rule).
    pub fn new() -> anyhow::Result<VirtualOutput> {
        let keyboard = build_keyboard().context("creating virtual keyboard")?;
        let mouse = build_mouse().context("creating virtual mouse")?;
        Ok(VirtualOutput { keyboard, mouse })
    }

    /// Emit a core `Event` to the appropriate virtual device.
    ///
    /// Routing: `is_mouse_button(ev.key)` → mouse device, otherwise keyboard.
    /// Value mapping: Press = 1, Release = 0, Repeat = 2.
    ///
    /// `VirtualDevice::emit` appends `SYN_REPORT` automatically.
    pub fn emit(&mut self, ev: &Event) -> anyhow::Result<()> {
        let value = match ev.state {
            KeyState::Press => 1,
            KeyState::Release => 0,
            KeyState::Repeat => 2,
        };
        let raw = InputEvent::new(EventType::KEY, ev.key.0, value);
        if is_mouse_button(ev.key) {
            self.mouse.emit(&[raw]).context("emitting mouse button event")?;
        } else {
            self.keyboard.emit(&[raw]).context("emitting keyboard event")?;
        }
        Ok(())
    }

    /// Pass an arbitrary `InputEvent` directly to the virtual mouse.
    ///
    /// Used by Task 11's mouse reader to forward EV_REL (motion) events.
    /// The caller is responsible for ensuring the event type matches the mouse
    /// device's declared capabilities.
    ///
    /// `VirtualDevice::emit` appends `SYN_REPORT` automatically.
    pub fn emit_raw_mouse(&mut self, ev: &InputEvent) -> anyhow::Result<()> {
        self.mouse.emit(&[*ev]).context("emitting raw mouse event")
    }
}

// ── Device builders ──────────────────────────────────────────────────────────

/// Build "Conduit Virtual Keyboard":
/// - All key codes 1..=767 **excluding** the mouse-button range 0x110..=0x117.
/// - No EV_REP (compositor handles autorepeat).
fn build_keyboard() -> std::io::Result<evdev::uinput::VirtualDevice> {
    let mut keys = AttributeSet::<Key>::new();

    for code in 1u16..=767 {
        // Skip the entire BTN_ block (0x100..=0x15f); only BTN_MOUSE (0x110..=0x117)
        // goes to the virtual mouse. Declaring joystick/gamepad/digitizer buttons on
        // a keyboard makes libinput misclassify the device.
        if (0x100..=0x15f).contains(&code) {
            continue;
        }
        keys.insert(Key::new(code));
    }

    VirtualDeviceBuilder::new()?
        .name("Conduit Virtual Keyboard")
        .with_keys(&keys)?
        .build()
}

/// Build "Conduit Virtual Mouse":
/// - Key codes BTN_LEFT (0x110)..=BTN_TASK (0x117).
/// - EV_REL axes: REL_X, REL_Y, REL_WHEEL, REL_HWHEEL.
fn build_mouse() -> std::io::Result<evdev::uinput::VirtualDevice> {
    let mut btns = AttributeSet::<Key>::new();
    for code in 0x110u16..=0x117 {
        btns.insert(Key::new(code));
    }

    let mut axes = AttributeSet::<RelativeAxisType>::new();
    axes.insert(RelativeAxisType::REL_X);
    axes.insert(RelativeAxisType::REL_Y);
    axes.insert(RelativeAxisType::REL_WHEEL);
    axes.insert(RelativeAxisType::REL_HWHEEL);

    VirtualDeviceBuilder::new()?
        .name("Conduit Virtual Mouse")
        .with_keys(&btns)?
        .with_relative_axes(&axes)?
        .build()
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use conduit_core::event::{Event, Key, KeyState};

    /// Creates both virtual devices and emits a KEY_A press and release.
    ///
    /// Requires `/dev/uinput` write access (e.g. `input` group membership or
    /// a udev rule).  Run with:
    ///
    /// ```sh
    /// cargo test -p conduit-daemon -- --ignored
    /// ```
    #[test]
    #[ignore]
    fn virtual_output_creates_and_emits() {
        let mut out = VirtualOutput::new().expect("VirtualOutput::new failed — check /dev/uinput permissions");

        // KEY_A = code 30
        let press = Event { key: Key(30), state: KeyState::Press, time_us: 0 };
        let release = Event { key: Key(30), state: KeyState::Release, time_us: 1000 };

        out.emit(&press).expect("emit KEY_A press failed");
        out.emit(&release).expect("emit KEY_A release failed");
    }
}
