import type { Model } from "./types.ts";
import type { ModelProvider } from "./providers.ts";

/**
 * The curated model catalog.
 *
 * Data only — every query over it lives in `capabilities.ts` or `defaults.ts`.
 *
 * `contextWindow` and `maxTokens` were captured from the third-party model metadata this
 * project shipped with before it owned this table — the same source the deployment compacted
 * against — so the numbers did not move when ownership did. They are pinned in
 * `test/model-registry.test.ts` so a hand edit cannot change compaction silently.
 *
 * Flags:
 *   base       offered in the base-model picker
 *   webui      allowed as a per-turn model on the web surface
 *   fastMode   the model has a faster serving mode the harness can request
 *   auxiliary  the cheap sibling used for judging, titling and screening
 */
export interface ModelEntry extends Model {
  provider: ModelProvider;
  contextWindow: number;
  maxTokens: number;
  base: boolean;
  webui: boolean;
  fastMode: boolean;
  auxiliary?: boolean;
}

export const MODEL_REGISTRY: readonly ModelEntry[] = [
  {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    base: true,
    webui: true,
    fastMode: false,
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    base: true,
    webui: true,
    fastMode: true,
  },
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    base: true,
    webui: true,
    fastMode: true,
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    base: true,
    webui: true,
    fastMode: false,
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    contextWindow: 200_000,
    maxTokens: 64_000,
    base: true,
    webui: true,
    fastMode: false,
    auxiliary: true,
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    provider: "openai",
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    base: true,
    webui: true,
    fastMode: false,
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    provider: "openai",
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    base: true,
    webui: true,
    fastMode: false,
  },
  {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    provider: "openai",
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    base: true,
    webui: true,
    fastMode: false,
    auxiliary: true,
  },
  {
    id: "openrouter/auto",
    name: "OpenRouter Auto",
    provider: "openrouter",
    contextWindow: 2_000_000,
    maxTokens: 4_096,
    base: true,
    webui: true,
    fastMode: false,
  },
  // Superseded releases: still resolvable so a pinned selection keeps working, but not offered
  // in any picker.
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    base: false,
    webui: false,
    fastMode: false,
  },
  {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    base: false,
    webui: false,
    fastMode: true,
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    base: false,
    webui: false,
    fastMode: true,
  },
];

const BY_ID = new Map(MODEL_REGISTRY.map((entry) => [entry.id, entry]));

/**
 * An OpenRouter model id is a `vendor/model` slug, optionally suffixed with a variant
 * (`openai/gpt-oss-20b:free`). OpenRouter is the only provider whose ids are namespaced, so the
 * slash is what distinguishes a routed model from a first-party one.
 *
 * Written without nested optional quantifiers on purpose: ids reach this function straight from
 * the OpenRouter catalog response, so the match has to stay linear in the length of the input.
 */
const OPENROUTER_SLUG = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

function isOpenRouterModelId(id: string): boolean {
  return id.length <= 200 && OPENROUTER_SLUG.test(id);
}

/**
 * Resolve a model id.
 *
 * Two things resolve: a curated catalog entry, with its measurements, and any well-formed
 * OpenRouter slug, which carries no local measurements because the live OpenRouter catalog is
 * what describes those models. Anything else is unknown, and callers treat that as a rejection.
 */
export function resolveModel(id: string): Model | undefined {
  const entry = BY_ID.get(id);
  if (entry) return entry;
  if (isOpenRouterModelId(id)) return { id, name: id, provider: "openrouter" };
  return undefined;
}

export function getRequiredModel(id: string): Model {
  const model = resolveModel(id);
  if (!model) throw new Error(`Unsupported model: ${id}`);
  return model;
}

export function modelDisplayName(id: string): string {
  return BY_ID.get(id)?.name ?? id;
}

export function modelEntry(id: string): ModelEntry | undefined {
  return BY_ID.get(id);
}

export const SELECTABLE_BASE_MODELS: ReadonlyArray<{ id: string; name: string }> = MODEL_REGISTRY.filter(
  (entry) => entry.base,
).map((entry) => ({ id: entry.id, name: entry.name }));

export const DEFAULT_WEBUI_MODEL_IDS: readonly string[] = MODEL_REGISTRY.filter((entry) => entry.webui).map(
  (entry) => entry.id,
);

export const FAST_MODE_MODEL_IDS: readonly string[] = MODEL_REGISTRY.filter((entry) => entry.fastMode).map(
  (entry) => entry.id,
);
