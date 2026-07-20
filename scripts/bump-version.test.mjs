import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpFiles } from "./bump-version.mjs";

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "bump-"));
  mkdirSync(join(root, "ui/src-tauri"), { recursive: true });
  writeFileSync(join(root, "ui/src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.1.0" }, null, 2));
  writeFileSync(join(root, "ui/package.json"), JSON.stringify({ version: "0.1.0" }, null, 2));
  writeFileSync(join(root, "ui/src-tauri/Cargo.toml"), '[package]\nname = "conduit-ui"\nversion = "0.1.0"\n');
  return root;
}

test("rewrites all three files", () => {
  const root = scaffold();
  bumpFiles("0.2.0", root);
  assert.match(readFileSync(join(root, "ui/src-tauri/tauri.conf.json"), "utf8"), /"version": "0\.2\.0"/);
  assert.match(readFileSync(join(root, "ui/package.json"), "utf8"), /"version": "0\.2\.0"/);
  assert.match(readFileSync(join(root, "ui/src-tauri/Cargo.toml"), "utf8"), /^version = "0\.2\.0"$/m);
});

test("rejects non-semver", () => {
  assert.throws(() => bumpFiles("nope", scaffold()));
});

test("scopes version bump to [package] section only", () => {
  const root = scaffold();
  // Add a [dependencies.foo] section with its own version line BEFORE [package]
  const cargoPath = join(root, "ui/src-tauri/Cargo.toml");
  const cargo = `[dependencies.foo]
version = "9.9.9"

[package]
name = "conduit-ui"
version = "0.1.0"

[dev-dependencies]
something = "0.0.1"
`;
  writeFileSync(cargoPath, cargo);

  bumpFiles("0.3.0", root);
  const result = readFileSync(cargoPath, "utf8");

  // [package] version should be updated
  assert.match(result, /^\[package\](?:[^\[]*\n)*version = "0\.3\.0"/m);
  // [dependencies.foo] version should NOT be touched
  assert.match(result, /^\[dependencies\.foo\](?:[^\[]*\n)*version = "9\.9\.9"/m);
});
