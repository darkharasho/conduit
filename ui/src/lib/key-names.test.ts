import { describe, it, expect } from "vitest";
import { KEY_NAMES, KEY_NAME_SET } from "./key-names";

describe("key-names", () => {
  it("KEY_NAMES includes f13-f24", () => {
    for (const name of ["f13", "f14", "f15", "f16", "f17", "f18", "f19", "f20", "f21", "f22", "f23", "f24"]) {
      expect(KEY_NAMES).toContain(name);
    }
  });

  it("KEY_NAME_SET is built from KEY_NAMES", () => {
    for (const name of KEY_NAMES) {
      expect(KEY_NAME_SET.has(name)).toBe(true);
    }
    // Also verify they're the same size
    expect(KEY_NAME_SET.size).toBe(KEY_NAMES.length);
  });

  it("key_table_count_pinned", () => {
    // Keep in sync with crates/conduit-core/src/keys.rs
    expect(KEY_NAMES.length).toBe(134);
  });
});
