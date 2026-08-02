import type { AssistantMessage, StopReason, ToolCall } from "./model-types.ts";

/**
 * The event protocol a streamed assistant turn emits.
 *
 * `start` comes first, then any number of partial updates, then exactly one terminator: `done`
 * for a completed turn, or `error` for one that failed or was aborted. Every event carries
 * `partial`, the message as accumulated so far, so a consumer can render without tracking state.
 */
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: Extract<StopReason, "stop" | "length" | "toolUse">; message: AssistantMessage }
  | { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage };

/**
 * A push-driven async iterable of assistant events.
 *
 * The producer calls `push` as the turn streams and `end` when it stops; the consumer either
 * iterates the events or awaits `result()` for the final message. Two behaviours matter and are
 * covered by `core-bridge-idle` and `core-bridge-retry`:
 *
 * - Events pushed before anyone iterates are queued, not dropped, so a consumer that attaches
 *   late still sees the whole turn.
 * - A terminator (`done` or `error`) settles `result()` immediately and closes the stream, so a
 *   consumer awaiting the result is never left hanging on a turn that already finished. Pushes
 *   after that point are ignored rather than reopening a closed stream.
 */
export class AssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
  #queue: AssistantMessageEvent[] = [];
  #waiting: Array<(result: IteratorResult<AssistantMessageEvent>) => void> = [];
  #done = false;
  #result: Promise<AssistantMessage>;
  #resolveResult!: (message: AssistantMessage) => void;

  constructor() {
    this.#result = new Promise<AssistantMessage>((resolve) => {
      this.#resolveResult = resolve;
    });
  }

  push(event: AssistantMessageEvent): void {
    if (this.#done) return;
    if (event.type === "done") {
      this.#done = true;
      this.#resolveResult(event.message);
    } else if (event.type === "error") {
      this.#done = true;
      this.#resolveResult(event.error);
    }
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.#queue.push(event);
  }

  /**
   * Close the stream. `result` settles a stream that never carried a terminator; without one,
   * `result()` stays pending, which is what an aborted-before-start turn looks like.
   */
  end(result?: AssistantMessage): void {
    this.#done = true;
    if (result !== undefined) this.#resolveResult(result);
    while (this.#waiting.length > 0) {
      this.#waiting.shift()!({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      if (this.#queue.length > 0) {
        yield this.#queue.shift()!;
        continue;
      }
      if (this.#done) return;
      const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => this.#waiting.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }

  result(): Promise<AssistantMessage> {
    return this.#result;
  }
}

export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}
