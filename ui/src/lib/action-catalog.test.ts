import { describe, expect, it } from "vitest";
import {
  CATALOG,
  chordLabel,
  entryForAction,
  entriesFor,
  parseComboInput,
  parseKeyInput,
  popularEntries,
  searchCatalog,
} from "./action-catalog";

describe("action catalog", () => {
  it("has copy/paste/undo as popular chord entries with canonical keys", () => {
    const copy = CATALOG.find((e) => e.id === "copy")!;
    expect(copy.action).toEqual({ kind: "chord", keys: ["leftctrl", "c"] });
    expect(copy.subtitle).toBe("Ctrl + C");
    expect(popularEntries().map((e) => e.id)).toContain("copy");
  });

  it("searches by label, subtitle, and keywords", () => {
    expect(searchCatalog("screenshot").map((e) => e.id)).toContain("screenshot");
    expect(searchCatalog("browser").map((e) => e.id)).toEqual(
      expect.arrayContaining(["back", "forward"]),
    );
    expect(searchCatalog("")).toEqual([]);
  });

  it("parses typed combos with alias canonicalization", () => {
    expect(parseComboInput("ctrl+z")).toEqual({ kind: "chord", keys: ["leftctrl", "z"] });
    expect(parseComboInput("ctrl+notakey")).toBeNull();
    expect(parseComboInput("plainword")).toBeNull();
  });

  it("labels chords humanly and reverse-looks-up catalog entries", () => {
    expect(chordLabel(["leftctrl", "leftshift", "t"])).toBe("Ctrl + Shift + T");
    expect(entryForAction({ kind: "chord", keys: ["leftctrl", "c"] })?.id).toBe("copy");
    expect(entryForAction({ kind: "key", key: "mute" })?.id).toBe("mute");
  });

  it("every category is non-empty and every entry has label+subtitle", () => {
    for (const cat of ["shortcuts", "keys", "media", "system"] as const) {
      expect(entriesFor(cat).length).toBeGreaterThan(0);
    }
    for (const e of CATALOG) {
      expect(e.label.length, e.id).toBeGreaterThan(0);
      expect(e.subtitle.length, e.id).toBeGreaterThan(0);
    }
  });
});

describe("parseKeyInput", () => {
  it("returns key action for canonical key names", () => {
    expect(parseKeyInput("esc")).toEqual({ kind: "key", key: "esc" });
    expect(parseKeyInput("1")).toEqual({ kind: "key", key: "1" });
    expect(parseKeyInput("f13")).toEqual({ kind: "key", key: "f13" });
  });

  it("resolves known aliases to canonical names", () => {
    expect(parseKeyInput("escape")).toEqual({ kind: "key", key: "esc" });
  });

  it("returns null for combo queries (contains '+')", () => {
    expect(parseKeyInput("ctrl+c")).toBeNull();
  });

  it("returns null for unknown key names", () => {
    expect(parseKeyInput("notakey")).toBeNull();
  });

  it("trims and lowercases input", () => {
    expect(parseKeyInput("  ESC  ")).toEqual({ kind: "key", key: "esc" });
  });
});
