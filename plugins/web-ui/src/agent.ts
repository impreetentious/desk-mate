import type { AssistantMessageEventStream } from "./assistant-event-stream.ts";
import type { AgentMessage, AssistantMessage, Context, ImageContent, Message, Model } from "./model-types.ts";

/**
 * The chat state machine the web UI drives.
 *
 * Deliberately much smaller than a general agent runtime, because this surface is not one: it
 * runs no tools and calls no provider. Every turn is a single call to `streamFn`, which posts to
 * the core API and streams the reply back; the core is where tool loops, retries and provider
 * transport live. So there is no tool-execution loop, no steering or follow-up queue, and no
 * multi-turn continuation — a turn ends when its stream terminates.
 *
 * What this class owns is the part the UI needs: the transcript, the streaming flags the
 * renderer reads, lifecycle events, and abort.
 */

export type StreamFn = (
  model: Model,
  context: Context,
  options?: { signal?: AbortSignal },
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AgentState {
  systemPrompt: string;
  model: Model;
  thinkingLevel: ThinkingLevel;
  tools: unknown[];
  messages: AgentMessage[];
  /** True from the moment a turn starts until its awaited `agent_end` listeners settle. */
  readonly isStreaming: boolean;
  /** The partial assistant message for the turn in flight, if any. */
  readonly streamingMessage?: AgentMessage;
  /** The error from the most recent failed or aborted turn, if any. */
  readonly errorMessage?: string;
}

export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage };

export type AgentListener = (event: AgentEvent, signal: AbortSignal) => Promise<void> | void;

export interface AgentOptions {
  initialState?: Partial<Pick<AgentState, "systemPrompt" | "model" | "thinkingLevel" | "tools" | "messages">>;
  streamFn?: StreamFn;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
}

const NO_MODEL: Model = { id: "", name: "", provider: "anthropic" };

function isAssistant(message: AgentMessage | undefined): message is AssistantMessage {
  return message?.role === "assistant";
}

export class Agent {
  #state: {
    systemPrompt: string;
    model: Model;
    thinkingLevel: ThinkingLevel;
    tools: unknown[];
    messages: AgentMessage[];
    isStreaming: boolean;
    streamingMessage?: AgentMessage;
    errorMessage?: string;
  };
  #listeners = new Set<AgentListener>();
  #controller?: AbortController;
  #idle: Promise<void> = Promise.resolve();

  streamFn: StreamFn = () => {
    throw new Error("Agent.streamFn is not set");
  };
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]> = (messages) => messages as Message[];

  constructor(options: AgentOptions = {}) {
    const initial = options.initialState ?? {};
    this.#state = {
      systemPrompt: initial.systemPrompt ?? "",
      model: initial.model ?? NO_MODEL,
      thinkingLevel: initial.thinkingLevel ?? "off",
      tools: [...(initial.tools ?? [])],
      messages: [...(initial.messages ?? [])],
      isStreaming: false,
    };
    if (options.streamFn) this.streamFn = options.streamFn;
    if (options.convertToLlm) this.convertToLlm = options.convertToLlm;
  }

  get state(): AgentState {
    return this.#state as AgentState;
  }

  /**
   * Subscribe to lifecycle events. Listener promises are awaited in subscription order and are
   * part of the turn's settlement, so `waitForIdle()` does not resolve until they have run.
   */
  subscribe(listener: AgentListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #emit(event: AgentEvent): Promise<void> {
    const signal = this.#controller?.signal ?? new AbortController().signal;
    // Iterating the Set directly is deliberate: a listener that unsubscribes during dispatch
    // should not be called again in this same pass.
    for (const listener of this.#listeners) {
      try {
        await listener(event, signal);
      } catch {
        // A misbehaving renderer must not abort the turn that fed it.
      }
    }
  }

  /** Append a user message and run a turn. */
  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    let appended: AgentMessage[];
    if (typeof input === "string") {
      appended = [
        {
          role: "user",
          content: images?.length ? [{ type: "text", text: input }, ...images] : input,
          timestamp: Date.now(),
        } satisfies Message,
      ];
    } else {
      appended = Array.isArray(input) ? input : [input];
    }
    this.#state.messages.push(...appended);
    await this.#run();
  }

  /** Run a turn against the transcript as it stands, appending no user message. */
  async continue(): Promise<void> {
    await this.#run();
  }

  /** Abort the turn in flight. The stream reports the abort; state settles through `agent_end`. */
  abort(): void {
    this.#controller?.abort();
  }

  /** Resolve once the turn in flight and its `agent_end` listeners have settled. */
  async waitForIdle(): Promise<void> {
    await this.#idle;
  }

  async #run(): Promise<void> {
    const turn = this.#turn();
    this.#idle = turn.catch(() => undefined);
    await turn;
  }

  async #turn(): Promise<void> {
    const controller = new AbortController();
    this.#controller = controller;
    this.#state.isStreaming = true;
    this.#state.errorMessage = undefined;
    this.#state.streamingMessage = undefined;
    await this.#emit({ type: "agent_start" });

    let final: AssistantMessage | undefined;
    try {
      const context: Context = {
        systemPrompt: this.#state.systemPrompt,
        messages: await this.convertToLlm(this.#state.messages),
      };
      const stream = await this.streamFn(this.#state.model, context, { signal: controller.signal });
      let started = false;
      for await (const event of stream) {
        const partial = "partial" in event ? event.partial : undefined;
        if (partial) {
          this.#state.streamingMessage = partial;
          if (!started) {
            started = true;
            await this.#emit({ type: "message_start", message: partial });
          } else {
            await this.#emit({ type: "message_update", message: partial });
          }
        }
        if (event.type === "done") final = event.message;
        else if (event.type === "error") final = event.error;
      }
      final ??= await stream.result();
    } catch (error) {
      final = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: "",
        provider: String(this.#state.model.provider ?? ""),
        model: this.#state.model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
    }

    if (final) {
      this.#state.messages.push(final);
      // The error lives on both the transcript message and agent state: the banner reads state,
      // the transcript renders the message, and they must agree.
      if (isAssistant(final) && final.errorMessage !== undefined) this.#state.errorMessage = final.errorMessage;
      await this.#emit({ type: "message_end", message: final });
    }

    this.#state.streamingMessage = undefined;
    this.#controller = undefined;
    await this.#emit({ type: "agent_end", messages: this.#state.messages });
    this.#state.isStreaming = false;
  }
}
