import { test } from "node:test";
import assert from "node:assert/strict";
import { getBaseModel, modelSupportsFastMode, setFastModeModelIds } from "../src/fast-mode.ts";

test("model ids resolve to a provider by shape, without privileging any one vendor", () => {
  assert.equal(getBaseModel("claude-opus-4-8").provider, "anthropic");
  assert.equal(getBaseModel("gpt-5.6-sol").provider, "openai");
  assert.equal(getBaseModel("openrouter/auto").provider, "openrouter");
  assert.equal(
    getBaseModel("vendor/released-after-this-build").provider,
    "openrouter",
    "a routed slug this build has never heard of is still an OpenRouter model",
  );
  assert.equal(
    getBaseModel("claude-released-after-this-build").provider,
    "anthropic",
    "a vendor-shaped id newer than this build is still attributed, not rejected",
  );
  assert.throws(() => getBaseModel("mystery-model"), /Unsupported/, "an id matching no shape is not guessed at");
});

test("what core says about a model wins over anything inferred here", () => {
  const described = getBaseModel("anthropic/claude-sonnet-4.5", {
    name: "Anthropic: Claude Sonnet 4.5",
    provider: "openrouter",
  });
  assert.equal(described.name, "Anthropic: Claude Sonnet 4.5");
  assert.equal(described.provider, "openrouter", "an Anthropic-looking slug routed via OpenRouter keeps its biller");
});

test("fast-mode support is fed from core's runtime config, not a hardcoded client copy", () => {
  setFastModeModelIds([]);
  assert.equal(modelSupportsFastMode("claude-opus-4-8"), false);

  setFastModeModelIds(["claude-opus-4-8", "claude-opus-4-7"]);
  assert.equal(modelSupportsFastMode("claude-opus-4-8"), true);
  assert.equal(modelSupportsFastMode("claude-sonnet-4-6"), false);
  assert.equal(modelSupportsFastMode("claude-haiku-4-5"), false);
  assert.equal(modelSupportsFastMode(undefined), false);
});
