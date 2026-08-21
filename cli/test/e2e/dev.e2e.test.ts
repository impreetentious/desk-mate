import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insideGitWorktree, NO_GIT_WORKTREE, repoRoot, rmDir, runCli, tmpGitRepo, writeConfig } from "./harness.ts";

const needsWorktree = { skip: insideGitWorktree() ? false : NO_GIT_WORKTREE };

test("normal dev reports unavailable contributor tooling before it is installed", needsWorktree, () => {
  const result = runCli(["dev", "status"], { cwd: repoRoot });
  assert.equal(result.code, 1);
  assert.match(result.out, /contributor dev tooling is unavailable/);
  assert.doesNotMatch(result.out, /MODULE_NOT_FOUND/);
});

test("delegated dev resolves org overrides, config, and fallback", (t) => {
  const withConfig = tmpGitRepo("dev-org-config");
  const withInvalidConfig = tmpGitRepo("dev-org-invalid-config");
  const withoutConfig = tmpGitRepo("dev-org-fallback");
  t.after(() => {
    rmDir(withConfig);
    rmDir(withInvalidConfig);
    rmDir(withoutConfig);
  });
  for (const root of [withConfig, withInvalidConfig, withoutConfig]) {
    mkdirSync(join(root, "scripts/dev"), { recursive: true });
    writeFileSync(join(root, "scripts/dev/cli.ts"), "console.log(process.env.DEV_INSTANCE_ORG_ID);\n");
  }
  writeConfig(withConfig, { orgId: "configured", target: "docker" });
  writeFileSync(
    join(withInvalidConfig, "deskmate.config.jsonc"),
    '{ // deploy config may be broken\n  "orgId": "configured",\n  "target": "k8s"\n}\n',
  );

  assert.equal(runCli(["dev", "status"], { cwd: withConfig, withRepoEnv: false }).stdout.trim(), "configured");
  assert.equal(runCli(["dev", "status"], { cwd: withInvalidConfig, withRepoEnv: false }).stdout.trim(), "configured");
  assert.equal(
    runCli(["dev", "up", "--org", "override"], { cwd: withConfig, withRepoEnv: false }).stdout.trim(),
    "override",
  );
  assert.equal(runCli(["dev", "status"], { cwd: withoutConfig, withRepoEnv: false }).stdout.trim(), "acme");
});

test("dev --ci with an unsupported subcommand is a clear usage error", () => {
  const result = runCli(["dev", "--ci", "frobnicate"], { cwd: repoRoot });
  assert.equal(result.code, 1);
  assert.match(result.out, /'dev --ci' supports up\|down/);
});

test("bare `dev --ci` defaults to CI up (not the pool-leasing dev path)", needsWorktree, () => {
  const result = runCli(["dev", "--ci"], { cwd: repoRoot, env: { SLACK_BOT_TOKEN: undefined } });
  assert.equal(result.code, 1);
  assert.match(result.out, /SLACK_BOT_TOKEN/);
});
