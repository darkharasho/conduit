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
  const cargoPath = join(rootDir, "ui/src-tauri/Cargo.toml");
  let cargo = readFileSync(cargoPath, "utf8");
  // Scope the version replacement to the [package] section only
  const packageIndex = cargo.indexOf("[package]");
  const nextSectionIndex = cargo.indexOf("[", packageIndex + 1);
  const beforePackage = cargo.substring(0, packageIndex);
  const packageSection = cargo.substring(
    packageIndex,
    nextSectionIndex === -1 ? cargo.length : nextSectionIndex
  );
  const afterPackage = nextSectionIndex === -1 ? "" : cargo.substring(nextSectionIndex);
  const updatedPackageSection = packageSection.replace(
    /^version = ".*"$/m,
    `version = "${version}"`
  );
  cargo = beforePackage + updatedPackageSection + afterPackage;
  writeFileSync(cargoPath, cargo);
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
