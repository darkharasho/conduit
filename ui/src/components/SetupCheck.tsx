import { useEffect, useState } from "react";
import { checkSetup } from "../lib/client";
import type { SetupResult } from "../lib/client";

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
      // Clipboard not available
    }
  };

  return (
    <button className="btn--copy" onClick={handleCopy} title="Copy to clipboard">
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
  const dotClass = ok
    ? "setup-check__dot--pass"
    : warning
    ? "setup-check__dot--warn"
    : "setup-check__dot--fail";

  return (
    <div className="setup-check__row">
      <span className={`setup-check__dot ${dotClass}`} />
      <span className="setup-check__label">{label}</span>
      {!ok && remediation && (
        <div className="setup-check__remediation">
          <code className="setup-check__cmd">{remediation}</code>
          <CopyButton text={remediation} />
        </div>
      )}
      {note && <div className="setup-check__note">{note}</div>}
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
        <div className="setup-check__title">Setup Check</div>
        <div className="setup-check__error">Could not run setup check: {error}</div>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="setup-check">
        <div className="setup-check__title">Setup Check</div>
        <div className="setup-check__intro">Checking system setup…</div>
      </div>
    );
  }

  const inputGroupWarning = !result.input_group && (result.daemon || result.uinput);

  return (
    <div className="setup-check">
      <div className="setup-check__title">Setup Check</div>
      <div className="setup-check__intro">
        The Conduit daemon is not running. Follow the steps below to get started.
      </div>

      <CheckRow
        label="uinput access (/dev/uinput writable)"
        ok={result.uinput}
        remediation={result.uinput ? undefined : UDEV_COMMAND}
      />

      <CheckRow
        label="input group membership"
        ok={result.input_group}
        warning={inputGroupWarning}
        remediation={result.input_group ? undefined : INPUT_GROUP_COMMAND}
        note={
          !result.input_group
            ? "On systemd/logind desktops, your active session may grant device access automatically."
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
          <div className="setup-check__extra-label">After installing, enable the systemd service:</div>
          <div className="setup-check__remediation">
            <code className="setup-check__cmd">{SYSTEMD_COMMAND}</code>
            <CopyButton text={SYSTEMD_COMMAND} />
          </div>
        </div>
      )}
    </div>
  );
}
