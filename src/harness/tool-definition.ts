import * as z from "zod";

/**
 * Deskmate's own tool-definition contract.
 *
 * Every harness adapter (Claude, Codex, OpenCode) consumes the same array of these and
 * translates it into whatever its runtime wants. Two representations of the parameters are
 * carried deliberately:
 *
 * - `parameters` is the authoring form, a Zod object. The Claude adapter hands its `.shape`
 *   straight to the Agent SDK, so no JSON-Schema round trip happens on that path.
 * - `jsonSchema` is the wire form. Codex (`inputSchema`) and OpenCode (`parameters`) forward
 *   it to their sidecars verbatim, so it is derived once here rather than at each call site.
 */

/** A single part of a tool result. `text` is the only part kind harnesses render today. */
interface ToolResultPart {
  type: string;
  text?: string;
}

interface ToolResult<TDetails = unknown> {
  content: ToolResultPart[];
  details?: TDetails;
  /** Ask the harness to end the turn after this call (approval pause, silent finish). */
  terminate?: boolean;
}

/** JSON Schema for a tool's parameters, as forwarded to Codex and OpenCode. */
type ToolParameterSchema = Record<string, unknown>;

export interface ToolDefinition<TParams = Record<string, never>> {
  /** Tool name as the model calls it. */
  name: string;
  /** Human-readable label for transcripts and UI. */
  label: string;
  /** Description handed to the model. */
  description: string;
  /** Authoring form: the Zod object the params were declared with. */
  parameters: z.ZodObject;
  /** Wire form: JSON Schema derived from `parameters`. */
  jsonSchema: ToolParameterSchema;
  execute(callId: string, params: TParams, signal?: AbortSignal): Promise<ToolResult>;
}

interface ToolSpec<TShape extends z.ZodRawShape> {
  name: string;
  label: string;
  description: string;
  parameters: z.ZodObject<TShape>;
  execute(callId: string, params: z.infer<z.ZodObject<TShape>>, signal?: AbortSignal): Promise<ToolResult>;
}

/**
 * Derive the wire schema from a Zod object.
 *
 * `io: "input"` matters: it describes what the model must send, before defaults are applied.
 * `$schema` is dropped — neither sidecar reads it, and Codex rejects unexpected root keys on
 * some tool payloads.
 */
function toolParameterSchema(parameters: z.ZodObject): ToolParameterSchema {
  const { $schema: _schema, ...rest } = z.toJSONSchema(parameters, { io: "input" }) as Record<string, unknown>;
  return rest;
}

/**
 * Define a tool, inferring the `execute` parameter type from the Zod schema.
 *
 * The explicit generic is what keeps `params` typed at each call site; a bare object literal
 * would widen it to `unknown` when the tool is collected into a `ToolDefinition[]`.
 */
export function defineTool<TShape extends z.ZodRawShape>(
  spec: ToolSpec<TShape>,
): ToolDefinition<z.infer<z.ZodObject<TShape>>> {
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters as z.ZodObject,
    jsonSchema: toolParameterSchema(spec.parameters as z.ZodObject),
    execute: spec.execute,
  };
}

/**
 * A tool of any parameter shape — the element type of the arrays harnesses iterate over.
 *
 * `execute` is declared as a method, so TypeScript compares its parameters bivariantly and a
 * `ToolDefinition<{ path: string }>` is assignable here. That is what lets a harness hand the
 * model's unvalidated arguments straight to whichever tool it dispatched to.
 */
export type AnyToolDefinition = ToolDefinition<unknown>;
