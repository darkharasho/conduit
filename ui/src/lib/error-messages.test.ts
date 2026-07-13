import { describe, expect, it } from "vitest";
import { ConduitError } from "./client";
import { presentError } from "./error-messages";

describe("presentError", () => {
  it("gives engine-not-running a start action and no jargon", () => {
    const p = presentError(
      new ConduitError("engine-not-running", "connect refused", "conduit.sock ECONNREFUSED"),
    );
    expect(p.title).toBe("Conduit's engine isn't running");
    expect(p.action).toBe("start-engine");
    for (const word of ["socket", "daemon", "ECONNREFUSED", ".sock"]) {
      expect(`${p.title} ${p.body}`.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("covers every known code plus unknown with a non-empty presentation", () => {
    const codes = [
      "engine-not-running", "permission-denied", "device-missing",
      "config-invalid", "apply-failed", "malformed-request",
      "timeout", "internal", "unknown",
    ] as const;
    for (const code of codes) {
      const p = presentError(new ConduitError(code, "m", "d"));
      expect(p.title.length, code).toBeGreaterThan(0);
      expect(p.body.length, code).toBeGreaterThan(0);
    }
  });
});
