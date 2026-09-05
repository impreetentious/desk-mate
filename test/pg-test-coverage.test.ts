import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

// Postgres-backed tests skip themselves unless DATABASE_URL is set, and the only place CI sets
// it is the core-postgres job, which runs exactly the files named in `test:pg`. A gated file left
// out of that list still reports green — by skipping everywhere. This guard keeps the two in step.
const GATE = /^const\s+\w+\s*=\s*process\.env\.DATABASE_URL\s*;/m;

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
  scripts: Record<string, string>;
};

const listed = new Set(pkg.scripts["test:pg"]!.split(/\s+/).filter((arg) => arg.endsWith(".test.ts")));

const gated = readdirSync(new URL("test/", root))
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => `test/${name}`)
  .filter((file) => GATE.test(readFileSync(new URL(file, root), "utf8")))
  .sort();

test("every DATABASE_URL-gated test file runs in the test:pg script", () => {
  assert.ok(gated.length > 0, "the gate pattern matched no files — it has drifted from the test suite");
  const missing = gated.filter((file) => !listed.has(file));
  assert.deepEqual(
    missing,
    [],
    `add these to the test:pg script or they never run against Postgres:\n${missing.join("\n")}`,
  );
});

test("test:pg only names test files that exist", () => {
  const all = new Set(gated);
  const stale = [...listed].filter((file) => !all.has(file)).sort();
  assert.deepEqual(stale, [], `test:pg names files that are gone or no longer Postgres-gated:\n${stale.join("\n")}`);
});
