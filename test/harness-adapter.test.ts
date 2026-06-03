import test from "node:test";
import assert from "node:assert/strict";
import { createMockHarness } from "../src/harness/mock-harness.ts";
import { createOpenCodeHarness } from "../src/harness/opencode-harness.ts";
import { createCodexHarness } from "../src/harness/codex-harness.ts";
import { createClaudeHarness } from "../src/harness/claude-harness.ts";

test("harness adapters declare their native control and tool transports", async (t) => {
  const mock = createMockHarness();
  const opencode = createOpenCodeHarness();
  const codex = createCodexHarness();
  const claude = createClaudeHarness();
  t.after(async () => {
    await opencode.turns.close?.();
  });

  assert.deepEqual(
    [
      mock.profile.controlTransport,
      opencode.profile.controlTransport,
      codex.profile.controlTransport,
      claude.profile.controlTransport,
    ],
    ["mock", "http", "json-rpc", "sdk"],
  );
  assert.deepEqual(
    [
      mock.profile.toolTransport,
      opencode.profile.toolTransport,
      codex.profile.toolTransport,
      claude.profile.toolTransport,
    ],
    ["mock", "plugin", "dynamic", "in-process-mcp"],
  );
  assert.equal(claude.profile.capabilities.has("fast-mode"), true);
  assert.equal(opencode.profile.capabilities.has("fast-mode"), false);
  assert.equal(opencode.profile.capabilities.has("thinking-level"), false);
});

test("tool presentation belongs to the adapter", () => {
  const claude = createClaudeHarness();
  const opencode = createOpenCodeHarness();

  assert.equal(claude.tools.name("read"), "read");
  assert.equal(opencode.tools.name("read"), "workspace_read");
  assert.equal(opencode.tools.name("execute"), "workspace_execute");
  assert.equal(opencode.tools.name("write"), "workspace_write");
});

test("model utilities are independent from turn control", async () => {
  const harness = createMockHarness();

  assert.equal(typeof harness.turns.runTurn, "function");
  assert.equal(await harness.models.oneShot?.("system", "hello"), "mock one-shot reply to: hello");
  assert.equal("oneShot" in harness.turns, false);
  assert.equal("runTurn" in harness.models, false);
});
