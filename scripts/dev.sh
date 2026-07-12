#!/usr/bin/env bash
# One-command dev environment: daemon (background) + Tauri UI (foreground).
# Usage: from ui/, `npm run dev` — or run this script directly from anywhere.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PKG_CONFIG_PATH="${PKG_CONFIG_PATH:-/usr/lib64/pkgconfig:/usr/share/pkgconfig}"

SOCK="${CONDUIT_SOCKET:-${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/conduit.sock}"

DAEMON_PID=""
cleanup() {
    if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
        echo "dev.sh: stopping daemon (pid $DAEMON_PID)"
        kill "$DAEMON_PID" 2>/dev/null || true
        wait "$DAEMON_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

if [[ -S "$SOCK" ]]; then
    # A daemon appears to be running already (e.g. via systemd) — reuse it.
    echo "dev.sh: existing daemon socket at $SOCK — not starting a second daemon"
else
    echo "dev.sh: building daemon..."
    cargo build -p conduit-daemon --manifest-path "$REPO_ROOT/Cargo.toml"
    echo "dev.sh: starting daemon (debug build; use the systemd unit for daily use)"
    "$REPO_ROOT/target/debug/conduit-daemon" &
    DAEMON_PID=$!
    # Give it a moment to bind the socket; fail fast if it died (e.g. permissions).
    for _ in $(seq 1 20); do
        [[ -S "$SOCK" ]] && break
        kill -0 "$DAEMON_PID" 2>/dev/null || { echo "dev.sh: daemon exited during startup" >&2; exit 1; }
        sleep 0.25
    done
fi

echo "dev.sh: launching UI (ctrl-c stops both)"
cd "$REPO_ROOT/ui"
npm run tauri dev
