import type { ModelProvider } from "./providers.ts";

/**
 * A model this deployment can route a turn to.
 *
 * Deliberately narrower than the shape the previous third-party registry returned. Every field
 * here has a reader in this repository; the following were dropped because nothing read them
 * once the in-process agent loop was removed — the surviving harnesses are sidecar CLIs that
 * own their own transport:
 *
 *   api, baseUrl, headers, compat  — request construction, now the sidecar's business
 *   reasoning, thinkingLevelMap    — effort is negotiated per harness, not per model row
 *   input                          — no caller branched on text/image support
 *   cost                           — spend is billed from `DEFAULT_AGENT_INPUT_USD_PER_MTOK`
 *                                    and from the usage each sidecar reports, never per row
 */
export interface Model {
  id: string;
  /** Display name, as shown in pickers and transcripts. */
  name: string;
  provider: ModelProvider;
  /**
   * Total context window in tokens. Absent for a model recognized only by the shape of its id
   * (an OpenRouter slug), where the catalog holds no measurements.
   */
  contextWindow?: number;
  /** Maximum output tokens per response. Absent for the same reason as `contextWindow`. */
  maxTokens?: number;
}
