import { useState, useEffect } from "react";
import type { SetupStatus, PermissionFixOutcome } from "../lib/client";
import { setupStatus, setupInstallService, setupFixPermissions, restartEngine, collectReport, ConduitError } from "../lib/client";
import { presentError } from "../lib/error-messages";
import { DeviceArt } from "../components/DeviceArt";

// ---- Step derivation --------------------------------------------------------

type StepState = "done" | "active" | "attention" | "pending";

interface StepDef {
  key: "service" | "uinput" | "evdev";
  label: string;
  note?: string;
  isDone: (s: SetupStatus) => boolean;
}

const STEP_DEFS: StepDef[] = [
  {
    key: "service",
    label: "Background service installed",
    note: "Starts with your computer, stays out of the way.",
    // Running implies it's working; installed-but-not-running still shows as broken.
    isDone: (s) => s.service_running,
  },
  {
    key: "uinput",
    label: "Allowing Conduit to press keys for you",
    isDone: (s) => s.uinput_ok,
  },
  {
    key: "evdev",
    label: "Access to your mice and keyboards",
    note: "May need you to log out and back in — we'll tell you if so.",
    isDone: (s) => s.evdev_ok,
  },
];

// ---- Types ------------------------------------------------------------------

type ActiveFix = "service" | "permissions" | null;

interface StepUIState {
  errorText: string | null;
  reloginNeeded: boolean;
}

// ---- Step icon --------------------------------------------------------------

function StepIcon({ state, number }: { state: StepState; number: number }) {
  return (
    <span className="setup__ico" data-state={state}>
      {state === "done" && "✓"}
      {state === "active" && <span className="setup__spinner" aria-label="Working…" />}
      {state === "attention" && "!"}
      {state === "pending" && number}
    </span>
  );
}

// ---- Main component ---------------------------------------------------------

export function SetupScreen({ onReady, variant = "firstrun" }: { onReady?: () => void; variant?: "firstrun" | "recovery" }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [activeFix, setActiveFix] = useState<ActiveFix>(null);
  const [stepUI, setStepUI] = useState<Record<string, StepUIState>>({
    service: { errorText: null, reloginNeeded: false },
    uinput: { errorText: null, reloginNeeded: false },
    evdev: { errorText: null, reloginNeeded: false },
  });
  const [showDetails, setShowDetails] = useState(false);
  const [attemptedRestart, setAttemptedRestart] = useState(false);
  const [copyConfirm, setCopyConfirm] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);

  const recheck = async () => {
    try {
      const s = await setupStatus();
      setStatus(s);
    } catch {
      // silently ignore recheck failures — user can retry by re-opening
    }
  };

  useEffect(() => {
    recheck();
  }, []);

  const handleRestartEngine = async () => {
    setRestartError(null);
    setAttemptedRestart(true);
    try {
      await restartEngine();
    } catch (e) {
      setRestartError(presentError(e instanceof ConduitError ? e : new ConduitError("unknown", String(e))).title);
    }
    await recheck();
  };

  const handleCopyReport = async () => {
    const report = await collectReport().catch(() => "");
    await navigator.clipboard.writeText(report).catch(() => {});
    setCopyConfirm(true);
  };

  const handleInstallService = async () => {
    setActiveFix("service");
    try {
      await setupInstallService();
    } catch (err) {
      const pres = presentError(err as ConduitError);
      setStepUI((prev) => ({
        ...prev,
        service: { ...prev.service, errorText: pres.title },
      }));
      setActiveFix(null);
      return;
    }
    await recheck();
    setActiveFix(null);
  };

  const handleFixPermissions = async (stepKey: "uinput" | "evdev") => {
    setActiveFix("permissions");
    let outcome: PermissionFixOutcome | null = null;
    try {
      outcome = await setupFixPermissions();
    } catch (err) {
      const pres = presentError(err as ConduitError);
      setStepUI((prev) => ({
        ...prev,
        [stepKey]: { ...prev[stepKey], errorText: pres.title },
      }));
      setActiveFix(null);
      return;
    }
    await recheck();
    if (outcome?.relogin_needed) {
      setStepUI((prev) => ({
        ...prev,
        evdev: { ...prev.evdev, reloginNeeded: true },
        uinput: { ...prev.uinput, reloginNeeded: true },
      }));
    }
    setActiveFix(null);
  };

  // Compute per-step display state
  function getStepState(def: StepDef, idx: number): StepState {
    if (!status) return "pending";
    if (def.isDone(status)) return "done";
    // First incomplete step is "attention" (unless a fix is running)
    const firstIncomplete = STEP_DEFS.findIndex((d) => !d.isDone(status));
    if (idx === firstIncomplete) {
      if (activeFix !== null) return "active";
      return "attention";
    }
    return "pending";
  }

  const allDone = status?.daemon_connected ?? false;

  // Recovery variant: service was installed but daemon isn't connected → single card
  if (variant === "recovery" && status !== null && status.service_installed && !status.daemon_connected) {
    return (
      <div className="setup">
        <div className="setup__recovery-card">
          <h2 className="setup__recovery-title">Conduit's engine stopped</h2>
          <p className="setup__recovery-body">
            Your buttons are back to their normal behavior until it starts again.
          </p>
          <button className="btn btn--primary" onClick={handleRestartEngine}>
            Start it again
          </button>
          {restartError && <div className="setup__step-error" role="alert">{restartError}</div>}
          {attemptedRestart && !status.daemon_connected && (
            <button className="btn setup__report-btn" onClick={handleCopyReport}>
              Copy report for a bug
            </button>
          )}
          {copyConfirm && (
            <span className="setup__copy-confirm">Copied. Paste it into a bug report.</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="setup">
      {/* Hero */}
      <div className="setup__hero">
        <div className="setup__hero-art">
          <DeviceArt archetype="mouse" width={56} />
          <DeviceArt archetype="keyboard" width={80} />
        </div>
        <h1 className="setup__title">Let's get Conduit running</h1>
        <p className="setup__sub">
          Conduit needs a couple of one-time permissions to remap your devices. You'll be asked for your password once.
        </p>
      </div>

      {/* Step cards */}
      <ol className="setup__steps">
        {STEP_DEFS.map((def, idx) => {
          const state = getStepState(def, idx);
          const ui = stepUI[def.key];
          return (
            <li key={def.key} className={`setup__step setup__step--${state}`}>
              <StepIcon state={state} number={idx + 1} />
              <div className="setup__step-body">
                <span className="setup__step-label">{def.label}</span>
                {def.note && state !== "done" && (
                  <span className="setup__step-note">{def.note}</span>
                )}

                {/* Error text (plain, inside the card) */}
                {ui.errorText && (
                  <span className="setup__step-error">{ui.errorText}</span>
                )}

                {/* Relogin notice for evdev */}
                {def.key === "evdev" && ui.reloginNeeded && !def.isDone(status!) && (
                  <span className="setup__step-relogin">
                    Log out and back in, then come back — your settings will be waiting.
                  </span>
                )}

                {/* Action buttons — shown only in attention state */}
                {state === "attention" && def.key === "service" && (
                  <button
                    className="btn setup__step-btn"
                    onClick={handleInstallService}
                  >
                    Set it up
                  </button>
                )}
                {state === "attention" && def.key === "uinput" && (
                  <button
                    className="btn setup__step-btn"
                    onClick={() => handleFixPermissions("uinput")}
                  >
                    Allow
                  </button>
                )}
                {state === "attention" && def.key === "evdev" && (
                  <button
                    className="btn setup__step-btn"
                    onClick={() => handleFixPermissions("evdev")}
                  >
                    Allow
                  </button>
                )}

                {/* Waiting indicator — shown when fix is running for uinput/evdev */}
                {state === "active" && (def.key === "uinput" || def.key === "evdev") && (
                  <span className="setup__step-waiting">
                    Waiting for your password in the system dialog…
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {/* Primary CTA */}
      <button
        className="btn btn--primary setup__cta"
        disabled={!allDone}
        onClick={() => onReady?.()}
      >
        Start using Conduit
      </button>

      {/* Technical details (jargon quarantine) */}
      <button
        className="setup__details-link"
        onClick={() => setShowDetails((v) => !v)}
      >
        Show technical details
      </button>
      {showDetails && status && (
        <pre className="setup__details">
          {status.details.join("\n")}
        </pre>
      )}
    </div>
  );
}
