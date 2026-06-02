/** The vendors that can bill a turn on this deployment. */
export const MODEL_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export function isModelProvider(value: unknown): value is ModelProvider {
  return typeof value === "string" && (MODEL_PROVIDERS as readonly string[]).includes(value);
}

/** Which providers this deployment holds usable credentials for. */
export interface ModelProviderAvailability {
  anthropic: boolean;
  openai: boolean;
  openrouter: boolean;
}

export const ALL_PROVIDERS_AVAILABLE: ModelProviderAvailability = { anthropic: true, openai: true, openrouter: true };

export function onlyProvider(provider: ModelProvider): ModelProviderAvailability {
  return { anthropic: false, openai: false, openrouter: false, [provider]: true };
}

/**
 * Narrow the deployment's configured keys to what a given harness can actually use.
 *
 * Key-authed harnesses run a sidecar CLI that reads the deployment environment, so their
 * availability is the configured key set. OpenCode has no OpenRouter route at all. Claude
 * authenticates through its own CLI and never consults a stored provider key, so nothing is
 * hidden from it on key grounds.
 */
export function modelProviderAvailabilityFor(
  harness: string,
  configKeys: ModelProviderAvailability,
): ModelProviderAvailability {
  if (harness === "opencode") return { ...configKeys, openrouter: false };
  if (harness === "codex") return configKeys;
  return ALL_PROVIDERS_AVAILABLE;
}
