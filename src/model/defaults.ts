import { SELECTABLE_BASE_MODELS } from "./catalog.ts";
import { modelServiceable, modelSupportedByHarness } from "./capabilities.ts";
import { modelProviderAvailabilityFor, onlyProvider, type ModelProvider } from "./providers.ts";
import type { ModelProviderAvailability } from "./providers.ts";

/** The model a deployment runs when it names none. */
export const DEFAULT_AGENT_MODEL_ID = "claude-opus-5";

/** Codex runs OpenAI models only, so it defaults away from the shipped Anthropic default. */
export const DEFAULT_CODEX_MODEL_ID = "gpt-5.6-sol";

/**
 * Flat input price used to estimate per-principal spend. A single figure on purpose: budgets are
 * a guardrail against runaway loops, not an invoice, and a per-model table would drift against
 * vendor pricing without anyone noticing.
 */
export const DEFAULT_AGENT_INPUT_USD_PER_MTOK = 5;

/**
 * Pick the model for a harness.
 *
 * An explicit configured pin wins whenever the harness can run it — a mismatch is rejected at
 * config load rather than silently swapped here. Otherwise the shipped default stands, unless
 * this deployment cannot bill its provider, in which case the first selectable model the harness
 * can both run and bill is used. With no billable option at all the default stands, so the
 * failure surfaces as a provider error rather than an arbitrary substitution.
 */
export function defaultModelForHarness(
  harness: string,
  configured?: string,
  providers?: ModelProviderAvailability,
): string {
  if (configured && modelSupportedByHarness(configured, harness)) return configured;
  const preferred = harness === "codex" ? DEFAULT_CODEX_MODEL_ID : DEFAULT_AGENT_MODEL_ID;
  if (!providers || modelServiceable(preferred, providers)) return preferred;
  const servable = SELECTABLE_BASE_MODELS.find(
    (model) => modelSupportedByHarness(model.id, harness) && modelServiceable(model.id, providers),
  );
  return servable?.id ?? preferred;
}

/** The model a harness would run if this provider were the only one configured, if any. */
export function defaultModelForProvider(harness: string, provider: ModelProvider): string | undefined {
  const only = onlyProvider(provider);
  if (!modelProviderAvailabilityFor(harness, only)[provider]) return undefined;
  const model = defaultModelForHarness(harness, undefined, only);
  return modelSupportedByHarness(model, harness) && modelServiceable(model, only) ? model : undefined;
}
