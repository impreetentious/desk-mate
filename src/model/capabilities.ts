import { MODEL_REGISTRY, modelEntry, resolveModel } from "./catalog.ts";
import type { ModelProviderAvailability } from "./providers.ts";

/**
 * Can this harness run this model?
 *
 * OpenCode and mock accept anything the catalog resolves. The two native CLIs accept their own
 * vendor's models, and additionally accept an unrecognized id that carries that vendor's naming
 * shape — a model released after this catalog was written should be pinnable without a code
 * change, and the provider rejects it if the guess is wrong.
 */
export function modelSupportedByHarness(id: string | undefined, harness: string): boolean {
  if (!id) return false;
  if (harness === "opencode" || harness === "mock") return Boolean(resolveModel(id));
  const provider = resolveModel(id)?.provider;
  if (harness === "claude") return provider === "anthropic" || /^claude-/i.test(id);
  if (harness === "codex") return provider === "openai" || /^(?:gpt-|o\d|codex|openai\/)/i.test(id);
  return false;
}

/** Does this deployment hold a key for the vendor that would bill this model? */
export function modelServiceable(id: string, providers: ModelProviderAvailability): boolean {
  const provider = resolveModel(id)?.provider;
  if (!provider) return false;
  if (provider === "openai") return providers.openai;
  if (provider === "anthropic") return providers.anthropic;
  if (provider === "openrouter") return providers.openrouter;
  return true;
}

export function serviceableModelIds(ids: readonly string[], providers: ModelProviderAvailability): string[] {
  return ids.filter((id) => modelServiceable(id, providers));
}

export function modelSupportsFastMode(modelId: string | undefined): boolean {
  return !!modelId && (modelEntry(modelId)?.fastMode ?? false);
}

/**
 * How much of a model's window this deployment will fill with history before compacting.
 *
 * Half the room left once the response budget is reserved. Undefined when the model carries no
 * measurements, which leaves the caller on its own default rather than a guessed number.
 */
const CONTEXT_BUDGET_FRACTION = 0.5;

export function contextTokenBudgetForModel(id: string): number | undefined {
  const model = resolveModel(id);
  const window = model?.contextWindow;
  const output = model?.maxTokens;
  if (typeof window !== "number" || window <= 0 || typeof output !== "number" || output <= 0 || output >= window)
    return undefined;
  return Math.floor((window - output) * CONTEXT_BUDGET_FRACTION);
}

/** The cheap sibling a given vendor offers for judging, titling and screening. */
export function auxiliaryModelForProvider(provider: string): string | undefined {
  return MODEL_REGISTRY.find((entry) => entry.auxiliary && entry.provider === provider)?.id;
}

/**
 * The auxiliary to pair with a base model. Always same-vendor, so a deployment that only holds
 * one provider's key never has a side call fail on a provider it cannot bill. Falls back to the
 * base model itself when its vendor offers no cheaper sibling.
 */
export function auxiliaryModelFor(baseModelId: string): string {
  const provider = resolveModel(baseModelId)?.provider;
  if (!provider) return baseModelId;
  return auxiliaryModelForProvider(provider) ?? baseModelId;
}
