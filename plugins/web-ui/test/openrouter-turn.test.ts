import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Agent } from "../src/agent.ts";
import type { Context } from "../src/model-types.ts";
import { makeOpenerStreamFn } from "../src/core-bridge.ts";
import { applyRuntimeOptions, getModelOptions } from "../src/model-options.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a web turn submits the fetched OpenRouter model selected by runtime config", async () => {
  applyRuntimeOptions(
    ["claude"],
    { claude: ["anthropic/claude-sonnet-4.5"] },
    { harnessId: "claude", modelId: "anthropic/claude-sonnet-4.5" },
    { "anthropic/claude-sonnet-4.5": { name: "Anthropic: Claude Sonnet 4.5", provider: "openrouter" } },
  );
  const model = getModelOptions()[0]!.model;
  const submitted: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_input, init) => {
    submitted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ status: "ok", reply: "ready" });
  }) as typeof fetch;
  const agent = { state: { model, messages: [], tools: [] } } as unknown as Agent;
  const stream = await makeOpenerStreamFn(
    "web:alice:new",
    agent,
    () => ({ harness: "claude" }),
    undefined,
  )(model, {} as Context);
  await stream.result();
  assert.equal(submitted[0]?.model, "anthropic/claude-sonnet-4.5");
  assert.equal(submitted[0]?.harness, "claude");
});
