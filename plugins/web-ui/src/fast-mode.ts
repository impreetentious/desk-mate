import type { Model } from "./model-types.ts";

/**
 * The web UI's view of a model.
 *
 * This surface never calls a provider, so it needs no metadata beyond what it displays and what
 * it sends back to core: an id, a name, and the provider that will bill the turn. Everything
 * else about a model — windows, pricing, capabilities — is core's business, and the picker is
 * fed from core's runtime config rather than from a catalog kept here. That is the whole point:
 * a second copy of the model registry is what drifted last time.
 */

const PROVIDER_BY_PREFIX: ReadonlyArray<[RegExp, Model["provider"]]> = [
  [/^claude-/i, "anthropic"],
  [/^(?:gpt-|o\d|codex)/i, "openai"],
];

/**
 * Resolve a model id for display.
 *
 * `fallback` carries what core said about the id — used verbatim when present, which is how
 * OpenRouter models (and any model newer than this build) get a real name and provider. Without
 * one, the provider is inferred from the id's shape, and an id that looks like nothing known is
 * rejected rather than silently mislabelled.
 */
export function getBaseModel(id: string, fallback?: { name: string; provider: string }): Model {
  if (fallback) return { id, name: fallback.name, provider: fallback.provider };
  if (id.includes("/")) return { id, name: id, provider: "openrouter" };
  for (const [pattern, provider] of PROVIDER_BY_PREFIX) {
    if (pattern.test(id)) return { id, name: id, provider };
  }
  throw new Error(`Unsupported model: ${id}`);
}

let fastModeModelIds = new Set<string>();

/** Fed from core's runtime config so the client keeps no hardcoded copy of the fast-mode list. */
export function setFastModeModelIds(ids: readonly string[] | undefined): void {
  fastModeModelIds = new Set(ids ?? []);
}

export function modelSupportsFastMode(modelId: string | undefined): boolean {
  return !!modelId && fastModeModelIds.has(modelId);
}
