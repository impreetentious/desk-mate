/**
 * The web UI's own message and model types.
 *
 * Field names match `src/model/types.ts` in core deliberately (§5.3): the two packages are
 * independent deployables that only meet over HTTP, but a shared vocabulary keeps them from
 * drifting the way two copies of a third-party registry did.
 *
 * This is a deliberate subset. The web UI never calls a provider — every turn goes to the core
 * API and comes back as text — so nothing here describes request construction.
 */

/** The wire protocol a message was produced under. Carried for display, never dispatched on. */
type Api = string;

type ModelProvider = "anthropic" | "openai" | "openrouter";

export interface Model {
  id: string;
  name: string;
  provider: ModelProvider | string;
  /** Wire protocol, carried onto assistant messages for display. Absent for a locally-resolved id. */
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface TextContent {
  type: "text";
  text: string;
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api?: Api;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
  timestamp: number;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

export interface Context {
  systemPrompt?: string;
  messages: Message[];
}

/**
 * A file the composer staged onto the next user message.
 *
 * `preview` is not modelled: the previous type carried one and nothing ever read it — the
 * composer renders image chips from `content` directly.
 */
export interface Attachment {
  id: string;
  type: "image" | "document";
  fileName: string;
  mimeType: string;
  size: number;
  /** base64 payload. */
  content: string;
  /** Plain text pulled out of a document, when the format allows it. */
  extractedText?: string;
}

/**
 * A staged user turn, before it is flattened for the wire.
 *
 * Its own role, not `user`, so the composer can tell a message it still owns from one already
 * sent. `defaultConvertToLlm` turns it into a plain user message with content blocks.
 */
export interface UserMessageWithAttachments {
  role: "user-with-attachments";
  content: string | (TextContent | ImageContent)[];
  attachments?: Attachment[];
  timestamp: number;
}

export type AgentMessage = Message | UserMessageWithAttachments;

export function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
