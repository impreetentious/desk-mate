import { test } from "node:test";
import assert from "node:assert/strict";
import {
  auxiliaryModelFor,
  auxiliaryModelForProvider,
  contextTokenBudgetForModel,
  modelServiceable,
  modelSupportedByHarness,
  modelSupportsFastMode,
  serviceableModelIds,
} from "../src/model/capabilities.ts";
import {
  DEFAULT_WEBUI_MODEL_IDS,
  FAST_MODE_MODEL_IDS,
  getRequiredModel,
  MODEL_REGISTRY,
  resolveModel,
  SELECTABLE_BASE_MODELS,
} from "../src/model/catalog.ts";
import { defaultModelForHarness, defaultModelForProvider } from "../src/model/defaults.ts";
import { MODEL_PROVIDERS, modelProviderAvailabilityFor, onlyProvider } from "../src/model/providers.ts";
import { validateWebTurnModelOptions } from "../src/core/turn-options.ts";

test("every registry model resolves in the catalog (nothing offered that turns can't serve)", () => {
  for (const m of MODEL_REGISTRY) {
    assert.ok(resolveModel(m.id), `registry model ${m.id} must resolve`);
  }
});

test("picker ⊆ gate: every selectable base model is web-ui-enabled", () => {
  const webui = new Set(DEFAULT_WEBUI_MODEL_IDS);
  for (const m of SELECTABLE_BASE_MODELS) {
    assert.ok(
      webui.has(m.id),
      `${m.id} is offered in the picker but not in the web-ui gate set — this is the drift that 403s`,
    );
  }
});

test("every web-ui-enabled model passes the web-turn model gate (no 403 for an offered model)", () => {
  for (const id of DEFAULT_WEBUI_MODEL_IDS) {
    assert.equal(
      validateWebTurnModelOptions({ model: id }, null),
      null,
      `${id} must not be refused by validateWebTurnModelOptions`,
    );
  }
});

test("regression: gpt-5.6-sol is web-ui-enabled (the reported 403)", () => {
  assert.ok(DEFAULT_WEBUI_MODEL_IDS.includes("gpt-5.6-sol"));
  assert.equal(validateWebTurnModelOptions({ model: "gpt-5.6-sol" }, null), null);
});

test("FAST_MODE_MODEL_IDS derives from the registry — the web-ui client reads this, keeps no copy", () => {
  assert.deepEqual(
    [...FAST_MODE_MODEL_IDS].sort(),
    MODEL_REGISTRY.filter((m) => m.fastMode)
      .map((m) => m.id)
      .sort(),
  );
  for (const id of FAST_MODE_MODEL_IDS) assert.equal(modelSupportsFastMode(id), true);
});

test("exposure is provider-key-aware: a model whose provider is unconfigured is not serviceable", () => {
  const noOpenai = { anthropic: true, openai: false, openrouter: false };
  assert.equal(modelServiceable("gpt-5.6-sol", noOpenai), false);
  assert.equal(modelServiceable("claude-opus-4-8", noOpenai), true);
  assert.deepEqual(serviceableModelIds(["claude-opus-4-8", "gpt-5.6-sol"], noOpenai), ["claude-opus-4-8"]);
});

test("provider-key gating applies only to key-authed harnesses (no over-hiding on CLI-auth harnesses)", () => {
  const noKeys = { anthropic: false, openai: false, openrouter: false };
  assert.deepEqual(modelProviderAvailabilityFor("opencode", noKeys), noKeys);
  assert.deepEqual(
    modelProviderAvailabilityFor("opencode", { anthropic: true, openai: true, openrouter: true }),
    { anthropic: true, openai: true, openrouter: false },
    "opencode has no OpenRouter route, whatever keys are configured",
  );
  assert.deepEqual(modelProviderAvailabilityFor("codex", noKeys), noKeys);
  assert.deepEqual(modelProviderAvailabilityFor("codex", { anthropic: false, openai: true, openrouter: false }), {
    anthropic: false,
    openai: true,
    openrouter: false,
  });
  assert.deepEqual(modelProviderAvailabilityFor("claude", noKeys), { anthropic: true, openai: true, openrouter: true });
  assert.deepEqual(modelProviderAvailabilityFor("mock", noKeys), { anthropic: true, openai: true, openrouter: true });
});

test("web-turn gate refuses a keyless model cleanly, accepts it once the provider is configured", () => {
  const noOpenai = { anthropic: true, openai: false, openrouter: false };
  const refused = validateWebTurnModelOptions({ model: "gpt-5.6-sol" }, null, noOpenai);
  assert.match(refused ?? "", /provider isn't configured/);
  assert.equal(
    validateWebTurnModelOptions({ model: "gpt-5.6-sol" }, null, { anthropic: true, openai: true, openrouter: false }),
    null,
  );
});

test("fast-mode support is registry-driven", () => {
  assert.equal(modelSupportsFastMode("claude-opus-4-8"), true);
  assert.equal(modelSupportsFastMode("gpt-5.6-sol"), false);
  assert.equal(modelSupportsFastMode(undefined), false);
  assert.equal(modelSupportsFastMode("nonexistent-model"), false);
});

test("every selectable base model resolves against the model catalog", () => {
  for (const m of SELECTABLE_BASE_MODELS) {
    const model = getRequiredModel(m.id);
    assert.equal(model.id, m.id);
    assert.ok(
      ["anthropic", "openai", "openrouter"].includes(String(model.provider)),
      `${m.id} has unexpected provider ${model.provider}`,
    );
  }
});

test("selectable models span providers (multi-provider is wired)", () => {
  const providers = new Set(SELECTABLE_BASE_MODELS.map((m) => getRequiredModel(m.id).provider));
  assert.ok(providers.has("anthropic"), "expected at least one Anthropic model");
  assert.ok(providers.has("openai"), "expected at least one OpenAI model (gpt-5.6)");
  assert.ok(providers.has("openrouter"), "expected an OpenRouter-hosted open-model option");
});

test("unknown models are not silently accepted", () => {
  assert.equal(resolveModel("claude-not-a-real-model"), undefined);
  assert.throws(() => getRequiredModel("claude-not-a-real-model"), /Unsupported model/);
});

test("native harnesses reject cross-provider pins and choose their own defaults", () => {
  assert.equal(modelSupportedByHarness("claude-opus-4-8", "claude"), true);
  assert.equal(modelSupportedByHarness("gpt-5.6-sol", "claude"), false);
  assert.equal(modelSupportedByHarness("gpt-5.6-sol", "codex"), true);
  assert.equal(modelSupportedByHarness("claude-opus-4-8", "codex"), false);
  assert.equal(modelSupportedByHarness("claude-future-9", "claude"), true);
  assert.equal(modelSupportedByHarness("gpt-future-9", "codex"), true);
  assert.equal(defaultModelForHarness("codex", "claude-opus-4-8"), "gpt-5.6-sol");
});

test("the default base model follows the providers a deployment can actually bill", () => {
  for (const provider of MODEL_PROVIDERS) {
    const only = onlyProvider(provider);
    const chosen = defaultModelForHarness("mock", undefined, only);
    assert.equal(
      modelServiceable(chosen, only),
      true,
      `a ${provider}-only deployment must default to a model ${provider} can serve, got ${chosen}`,
    );
  }
  assert.equal(defaultModelForHarness("mock", undefined, onlyProvider("openrouter")), "openrouter/auto");
  assert.equal(defaultModelForHarness("mock", undefined, onlyProvider("openai")), "gpt-5.6-sol");
});

test("provider-blind callers and explicit pins keep the shipped default", () => {
  assert.equal(defaultModelForHarness("mock"), "claude-opus-5");
  assert.equal(defaultModelForHarness("mock", undefined, onlyProvider("anthropic")), "claude-opus-5");
  assert.equal(
    defaultModelForHarness("mock", "claude-sonnet-5", onlyProvider("openrouter")),
    "claude-sonnet-5",
    "an explicit pin is never silently swapped — the mismatch is rejected at config load instead",
  );
  assert.equal(
    defaultModelForHarness("mock", undefined, { anthropic: false, openai: false, openrouter: false }),
    "claude-opus-5",
    "with no provider at all the shipped default stands rather than an arbitrary pick",
  );
});

test("a provider that cannot serve a harness has no default model for it", () => {
  assert.equal(defaultModelForProvider("mock", "openrouter"), "openrouter/auto");
  assert.equal(defaultModelForProvider("codex", "openai"), "gpt-5.6-sol");
  assert.equal(defaultModelForProvider("claude", "anthropic"), "claude-opus-5");
  assert.equal(defaultModelForProvider("codex", "anthropic"), undefined, "the Codex CLI runs no Anthropic model");
  assert.equal(defaultModelForProvider("claude", "openrouter"), undefined, "the Claude CLI runs no OpenRouter model");
  assert.equal(defaultModelForProvider("opencode", "openrouter"), undefined, "opencode has no OpenRouter route");
});

test("the curated catalog contains only current model families", () => {
  assert.deepEqual(
    SELECTABLE_BASE_MODELS.map((model) => model.id),
    [
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "openrouter/auto",
    ],
  );
  assert.equal(getRequiredModel("gpt-5.6-sol").contextWindow, 1_050_000);
});

test("auxiliary models come from the configured base model's own provider", () => {
  assert.equal(
    auxiliaryModelFor("claude-opus-5"),
    "claude-haiku-4-5",
    "the deployment default resolves an Anthropic auxiliary",
  );
  assert.equal(auxiliaryModelFor("claude-opus-4-8"), "claude-haiku-4-5");
  assert.equal(auxiliaryModelFor("claude-fable-5"), "claude-haiku-4-5");
  assert.equal(
    auxiliaryModelFor("gpt-5.6-sol"),
    "gpt-5.6-luna",
    "an OpenAI deployment gets an OpenAI auxiliary, never Haiku",
  );
  assert.equal(auxiliaryModelFor("gpt-5.6-terra"), "gpt-5.6-luna");
});

test("the Anthropic auxiliary is resolvable by provider, so Anthropic-only surfaces keep working", () => {
  assert.equal(auxiliaryModelForProvider("anthropic"), "claude-haiku-4-5");
  assert.equal(auxiliaryModelForProvider("openai"), "gpt-5.6-luna");
  assert.equal(auxiliaryModelForProvider("nope"), undefined);
});

test("auxiliary selection falls back to the base model when its provider has no cheaper sibling", () => {
  assert.equal(
    auxiliaryModelFor("openrouter/auto"),
    "openrouter/auto",
    "the only OpenRouter entry is its own auxiliary",
  );
  assert.equal(
    auxiliaryModelFor("claude-not-a-real-model"),
    "claude-not-a-real-model",
    "an unresolvable base is returned untouched",
  );
});

test("an auxiliary is never less serviceable than the base model it was derived from", () => {
  const providerSets = [
    { anthropic: true, openai: false, openrouter: false },
    { anthropic: false, openai: true, openrouter: false },
    { anthropic: false, openai: false, openrouter: true },
    { anthropic: false, openai: false, openrouter: false },
  ];
  for (const m of SELECTABLE_BASE_MODELS) {
    const auxiliary = auxiliaryModelFor(m.id);
    assert.equal(
      getRequiredModel(auxiliary).provider,
      getRequiredModel(m.id).provider,
      `${m.id} resolved a cross-provider auxiliary (${auxiliary})`,
    );
    for (const providers of providerSets) {
      assert.equal(
        modelServiceable(auxiliary, providers),
        modelServiceable(m.id, providers),
        `${m.id} -> ${auxiliary} changed serviceability under ${JSON.stringify(providers)}`,
      );
    }
  }
});

test("context token budget is half of each model's real input room", () => {
  assert.equal(getRequiredModel("claude-fable-5").contextWindow, 1_000_000);
  assert.equal(contextTokenBudgetForModel("claude-fable-5"), Math.floor((1_000_000 - 128_000) * 0.5));
  const sol = contextTokenBudgetForModel("gpt-5.6-sol");
  assert.equal(sol, Math.floor((1_050_000 - 128_000) * 0.5));
  assert.ok(sol !== undefined && sol < 1_050_000 * 0.5, "budget stays below half the window");
  assert.equal(contextTokenBudgetForModel("claude-not-a-real-model"), undefined);
  for (const m of SELECTABLE_BASE_MODELS) {
    const budget = contextTokenBudgetForModel(m.id);
    assert.ok(budget !== undefined && budget >= 60_000, `${m.id} budget ${budget} suspiciously small`);
  }
});

test("catalog measurements are pinned: compaction reads these, and a hand edit must not move them", () => {
  const measured = MODEL_REGISTRY.map((m) => [m.id, m.provider, m.contextWindow, m.maxTokens] as const);
  assert.deepEqual(measured, [
    ["claude-fable-5", "anthropic", 1_000_000, 128_000],
    ["claude-opus-5", "anthropic", 1_000_000, 128_000],
    ["claude-opus-4-8", "anthropic", 1_000_000, 128_000],
    ["claude-sonnet-5", "anthropic", 1_000_000, 128_000],
    ["claude-haiku-4-5", "anthropic", 200_000, 64_000],
    ["gpt-5.6-sol", "openai", 1_050_000, 128_000],
    ["gpt-5.6-terra", "openai", 1_050_000, 128_000],
    ["gpt-5.6-luna", "openai", 1_050_000, 128_000],
    ["openrouter/auto", "openrouter", 2_000_000, 4_096],
    ["claude-sonnet-4-6", "anthropic", 1_000_000, 128_000],
    ["claude-opus-4-7", "anthropic", 1_000_000, 128_000],
    ["claude-opus-4-6", "anthropic", 1_000_000, 128_000],
  ]);
});

test("an OpenRouter slug resolves by shape; anything else unknown does not", () => {
  assert.deepEqual(resolveModel("vendor/some-model"), {
    id: "vendor/some-model",
    name: "vendor/some-model",
    provider: "openrouter",
  });
  assert.equal(resolveModel("openai/gpt-oss-20b:free")?.provider, "openrouter");
  assert.equal(resolveModel("not-a-slug"), undefined);
  assert.equal(resolveModel("trailing/"), undefined);
  assert.equal(resolveModel("/leading"), undefined);
  assert.equal(
    contextTokenBudgetForModel("vendor/some-model"),
    undefined,
    "a shape-resolved model carries no measurements, so it gets no budget rather than a guessed one",
  );
});
