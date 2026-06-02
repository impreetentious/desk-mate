/** The agent runtimes this deployment can route a turn to. */
export const HARNESS_IDS = ["opencode", "codex", "claude", "mock"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

/**
 * The harness the API assumes when a deployment names none. Kept in step with
 * `DEFAULT_AGENT_MODEL_ID`, which is an Anthropic model.
 */
export const DEFAULT_HARNESS_ID = "claude" as const;

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === "string" && (HARNESS_IDS as readonly string[]).includes(value);
}
