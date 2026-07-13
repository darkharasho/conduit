import type { ConduitError, ErrorCode } from "./client";

export type RecoveryAction = "start-engine" | "open-setup" | "retry" | "copy-report";

export interface ErrorPresentation {
  title: string;
  body: string;
  action: RecoveryAction | null;
}

const TABLE: Record<ErrorCode, ErrorPresentation> = {
  "engine-not-running": {
    title: "Conduit's engine isn't running",
    body: "Your buttons are back to their normal behavior until it starts again.",
    action: "start-engine",
  },
  "permission-denied": {
    title: "Conduit doesn't have permission to do that",
    body: "A one-time setup step is missing or was rolled back by a system update.",
    action: "open-setup",
  },
  "device-missing": {
    title: "That device isn't connected",
    body: "Plug it back in — its settings are saved and will come right back.",
    action: null,
  },
  "config-invalid": {
    title: "That change couldn't be applied",
    body: "Nothing was saved, so everything still works the way it did before.",
    action: "retry",
  },
  "apply-failed": {
    title: "That didn't stick",
    body: "The change couldn't be saved. Your previous settings are untouched.",
    action: "retry",
  },
  "malformed-request": {
    title: "Something went wrong",
    body: "The app and its engine disagreed. Restarting Conduit usually fixes this.",
    action: "copy-report",
  },
  timeout: {
    title: "That took too long",
    body: "Conduit stopped waiting. It's safe to try again.",
    action: "retry",
  },
  internal: {
    title: "Something went wrong",
    body: "An unexpected problem came up. Trying again is safe.",
    action: "copy-report",
  },
  unknown: {
    title: "Something went wrong",
    body: "An unexpected problem came up. Trying again is safe.",
    action: "copy-report",
  },
};

export function presentError(err: ConduitError): ErrorPresentation {
  return TABLE[err.code] ?? TABLE.unknown;
}
