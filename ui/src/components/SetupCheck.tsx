import { useEffect, useState } from "react";
import { checkSetup } from "../lib/client";
import type { SetupResult } from "../lib/client";

// Exact remediation commands from README
const UDEV_COMMAND =
  "sudo cp packaging/99-conduit.rules /etc/udev/rules.d/ && sudo udevadm control --reload && sudo udevadm trigger";
const INPUT_GROUP_COMMAND = "sudo usermod -aG input $USER";
const BUILD_COMMAND =
  "cargo build --release && install -Dm755 target/release/conduit-daemon ~/.local/bin/";
const SYSTEMD_COMMAND =
  "mkdir -p ~/.config/systemd/user/ && cp packaging/conduit.service ~/.config/systemd/user/ && systemctl --user enable --now conduit.service";

interface CopyButtonProps {
  text: string;
}

function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard not available in this context
    }
  };

  return (
    <button className="btn btn--copy" onClick={handleCopy} title="Copy to clipboard">
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

interface CheckRowProps {
  label: string;
  ok: boolean;
  warning?: boolean;
  remediation?: string;
  note?: string;
}

function CheckRow({ label, ok, warning, remediation, note }: CheckRowProps) {
  const statusClass = ok
    ? "setup-check__status--pass"
    : warning
    ? "setup-check__status--warn"
    : "setup-check__status--fail";
  const statusLabel = ok ? "OK" : warning ? "WARN" : "FAIL";

  return (
    <div className={`setup-check__row ${ok ? "" : warning ? "setup-check__row--warn" : "setup-check__row--fail"}`}>
      <span className={`setup-check__status ${statusClass}`}>{statusLabel}</span>
      <span className="setup-check__label">{label}</span>
      {!ok && remediation && (
        <div className="setup-check__remediation">
          <code className="setup-check__cmd">{remediation}</code>
          <CopyButton text={remediation} />
        </div>
      )}
      {note && (
        <div className="setup-check__note muted">{note}</div>
      )}
    </div>
  );
}

export function SetupCheck() {
  const [result, setResult] = useState<SetupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkSetup()
      .then(setResult)
      .catch((err) => setError(String(err)));
  }, []);

  if (error) {
    return (
      <div className="setup-check setup-check--error">
        <h3 className="setup-check__title">Setup Check</h3>
        <p className="setup-check__error">Could not run setup check: {error}</p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="setup-check">
        <h3 className="setup-check__title">Setup Check</h3>
        <p className="muted">Checking system setup…</p>
      </div>
    );
  }

  // input_group may be fine on logind desktops — treat as warning when
  // daemon is true or uinput is true (indicating session grants access)
  const inputGroupWarning = !result.input_group && (result.daemon || result.uinput);

  return (
    <div className="setup-check">
      <h3 className="setup-check__title">Setup Check</h3>
      <p className="setup-check__intro muted">
        The Conduit daemon is not running. Follow the steps below to get started.
      </p>

      <div className="setup-check__rows">
        <CheckRow
          label="uinput access (/dev/uinput writable)"
          ok={result.uinput}
          remediation={
            result.uinput
              ? undefined
              : UDEV_COMMAND
          }
        />

        <CheckRow
          label="input group membership"
          ok={result.input_group}
          warning={inputGroupWarning}
          remediation={
            result.input_group
              ? undefined
              : INPUT_GROUP_COMMAND
          }
          note={
            !result.input_group
              ? "On systemd/logind desktops, your active session may grant device access automatically — this may not be required."
              : undefined
          }
        />

        <CheckRow
          label="config valid (conduit.toml)"
          ok={result.config_ok}
          note={
            !result.config_ok
              ? "Check your conduit.toml for syntax errors, or delete it to regenerate defaults."
              : undefined
          }
        />

        <CheckRow
          label="daemon running"
          ok={result.daemon}
          remediation={result.daemon ? undefined : BUILD_COMMAND}
        />

        {!result.daemon && (
          <div className="setup-check__extra">
            <p className="setup-check__extra-label muted">
              After installing, enable the systemd service:
            </p>
            <div className="setup-check__remediation">
              <code className="setup-check__cmd">{SYSTEMD_COMMAND}</code>
              <CopyButton text={SYSTEMD_COMMAND} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
