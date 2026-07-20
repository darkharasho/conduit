import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function bumpFiles(version, rootDir) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a plain semver: ${version}`);
  const json = (rel) => {
    const p = join(rootDir, rel);
    const obj = JSON.parse(readFileSync(p, "utf8"));
    obj.version = version;
    writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  };
  json("ui/src-tauri/tauri.conf.json");
  json("ui/package.json");

  const cargo = (rel) => {
    const cargoPath = join(rootDir, rel);
    let contents = readFileSync(cargoPath, "utf8");
    // Scope the version replacement to the [package] section only
    const packageIndex = contents.indexOf("[package]");
    const nextSectionIndex = contents.indexOf("[", packageIndex + 1);
    const beforePackage = contents.substring(0, packageIndex);
    const packageSection = contents.substring(
      packageIndex,
      nextSectionIndex === -1 ? contents.length : nextSectionIndex
    );
    const afterPackage = nextSectionIndex === -1 ? "" : contents.substring(nextSectionIndex);
    const updatedPackageSection = packageSection.replace(
      /^version = ".*"$/m,
      `version = "${version}"`
    );
    contents = beforePackage + updatedPackageSection + afterPackage;
    writeFileSync(cargoPath, contents);
  };
  cargo("ui/src-tauri/Cargo.toml");
  cargo("crates/conduit-daemon/Cargo.toml");
  cargo("crates/conduit-core/Cargo.toml");
  cargo("crates/conduit-proto/Cargo.toml");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  try {
    bumpFiles(process.argv[2] ?? "", process.cwd());
    console.log(`bumped to ${process.argv[2]}`);
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
