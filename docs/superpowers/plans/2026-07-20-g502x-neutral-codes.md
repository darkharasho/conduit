# G502 X Neutral-Code Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Onboard Esc→F13 and Space→F14 on the G502 X PLUS, reproduced in conduit's default profile, so all four keyboard-emitting buttons (F13/F14/F15/F18) are per-app remappable.

**Architecture:** Machine setup only, no repo code. Same Solaar dump→edit→load path proven earlier today; conduit.toml gains two default-profile lines.

**Tech Stack:** Solaar 1.1.20 (pip), python one-liner for scoped YAML edit, systemd user service restart.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-20-g502x-neutral-codes-design.md`
- Edit ONLY profile 1 `!Button` lines with `type: 2`; profiles 2–5 contain identical values and must not change.
- HID usages: Esc=41, Space=44, F13=104, F14=105.
- Backup before writing; daemon socket takes ~2s to bind after restart.

---

### Task 1: Onboard rewrite Esc→F13, Space→F14

- [ ] **Step 1: Dump + backup**

```bash
timeout 60 solaar profiles "G502 X PLUS" 2>/dev/null > /tmp/g502x-onboard2.yaml
cp /tmp/g502x-onboard2.yaml ~/.config/conduit/g502x-onboard-backup-2026-07-20-b.yaml
```

Expected: file starts with `#Dumping profiles`, contains 5 `!OnboardProfile`.

- [ ] **Step 2: Scoped edit (profile 1 only)**

```bash
python3 - <<'EOF'
import re
path = "/tmp/g502x-onboard2.yaml"
lines = open(path).read().splitlines(keepends=True)
in_p1 = False
swaps = {"value: 41}": "value: 104}", "value: 44}": "value: 105}"}
done = set()
for i, ln in enumerate(lines):
    if re.match(r"^  1: !OnboardProfile", ln): in_p1 = True
    elif re.match(r"^  \d+: !OnboardProfile", ln): in_p1 = False
    if in_p1 and "!Button" in ln and "type: 2" in ln:
        for old, new in swaps.items():
            if old in ln and old not in done:
                lines[i] = ln.replace(old, new); done.add(old)
open(path, "w").write("".join(lines))
assert done == set(swaps), f"only replaced {done}"
print("edited OK")
EOF
```

Expected: `edited OK`.

- [ ] **Step 3: Load + verify**

```bash
timeout 90 solaar profiles "G502 X PLUS" /tmp/g502x-onboard2.yaml 2>&1 | grep Wrote
timeout 60 solaar profiles "G502 X PLUS" 2>/dev/null | sed -n '/^  1: /,/^  2: /p' | grep -E "value: (41|44|104|105)}"
```

Expected: `Wrote 1 sectors`; re-dump profile 1 shows 104 and 105, no 41/44.

### Task 2: Config + reload

- [ ] **Step 1: Add default mappings** — in `~/.config/conduit/conduit.toml`, `[profile.default.keys]` becomes:

```toml
[profile.default.keys]
f13 = "esc"
f14 = "space"
f15 = "v"
```

- [ ] **Step 2: Restart + verify**

```bash
systemctl --user restart conduit.service && sleep 3
python3 -c "
import socket, os, json
s = socket.socket(socket.AF_UNIX); s.connect(os.environ['XDG_RUNTIME_DIR']+'/conduit.sock')
s.sendall(b'{\"type\":\"get_status\"}\n')
st = json.loads(s.recv(65536).decode().splitlines()[0])
print(st['active_profile'], st['grabbed_devices'])"
```

Expected: profile named, G502X node among grabbed devices, no journal parse errors.

### Task 3: User verification

- [ ] Rear trigger = Esc, b5 = Space (any app); F18 button unchanged; F15 side button still v / Shift-in-RuneLite.
