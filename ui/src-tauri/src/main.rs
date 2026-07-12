// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer produces a blank window on NVIDIA + Wayland.
    // Set before the webview initializes; export WEBKIT_DISABLE_DMABUF_RENDERER=0
    // to opt back in on hardware where it works.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    conduit_ui_lib::run();
}
