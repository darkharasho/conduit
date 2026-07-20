#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
triple=$(rustc -vV | sed -n 's/^host: //p')
cargo build --release -p conduit-daemon
mkdir -p ui/src-tauri/bin
cp target/release/conduit-daemon "ui/src-tauri/bin/conduit-daemon-${triple}"
echo "sidecar ready: ui/src-tauri/bin/conduit-daemon-${triple}"
