#!/usr/bin/env node
// Every release-version surface has to agree with package.json. The core and
// the published CLI ship in lockstep, so both packages carry the same version.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Every release-version surface is listed here; adding a new one means adding it here too.
const read = (file) => readFileSync(path.join(root, file), "utf8");
const json = (file) => JSON.parse(read(file));
const has = (file) => existsSync(path.join(root, file));

const version = json("package.json").version;
const errors = [];

if (!version) errors.push("package.json is missing a version");

function checkLock(file, label) {
  if (!has(file)) return errors.push(`${label} is missing`);
  const lock = json(file);
  if (lock.version !== version) errors.push(`${label} version ${lock.version} != ${version}`);
  const rootPkg = lock.packages?.[""]?.version;
  if (rootPkg !== version) errors.push(`${label} packages[""].version ${rootPkg} != ${version}`);
}

checkLock("package-lock.json", "package-lock.json");

// README carries a `**Version:** vX.Y.Z` marker as its last line.
const marker = read("README.md").match(/\*\*Version:\*\*\s*v?([0-9]+\.[0-9]+\.[0-9]+)/)?.[1];
if (!marker) errors.push("README.md is missing its **Version:** vX.Y.Z marker");
else if (marker !== version) errors.push(`README.md version ${marker} != ${version}`);

const source = read("src/version.ts").match(/DESKMATE_VERSION\s*=\s*"([^"]+)"/)?.[1];
if (!source) errors.push("src/version.ts is missing DESKMATE_VERSION");
else if (source !== version) errors.push(`src/version.ts ${source} != ${version}`);

// The CLI is published separately but versioned in lockstep with core.
if (has("cli/package.json")) {
  const cli = json("cli/package.json").version;
  if (cli !== version) errors.push(`cli/package.json ${cli} != ${version}`);
  checkLock("cli/package-lock.json", "cli/package-lock.json");
  const linked = json("package-lock.json").packages?.cli?.version;
  if (linked !== version) errors.push(`package-lock.json packages.cli.version ${linked} != ${version}`);
}

// Plugins live in this repo and ship with it, so each one carries the release version too.
if (has("plugins")) {
  for (const name of readdirSync(path.join(root, "plugins")).sort()) {
    const dir = `plugins/${name}`;
    if (!has(`${dir}/package.json`)) continue;
    const plugin = json(`${dir}/package.json`).version;
    if (plugin !== version) errors.push(`${dir}/package.json ${plugin} != ${version}`);
    if (has(`${dir}/package-lock.json`)) checkLock(`${dir}/package-lock.json`, `${dir}/package-lock.json`);
  }
}

if (errors.length) {
  console.error("version-coherence FAILED:");
  for (const error of errors) console.error(` - ${error}`);
  process.exit(1);
}

console.log(`version-coherence OK — ${version}`);
