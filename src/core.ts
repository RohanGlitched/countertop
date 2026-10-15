/**
 * The parts of Countertop's host that decide things, kept free of the DOM so they can be tested in Node:
 * the fetch the MCP client uses, the first guess at a tool's arguments, and which tool calls need a person's yes.
 */

/**
 * Wraps a fetch so the MCP client's optional GET stream is answered locally with 405. A stateless Streamable
 * HTTP server has no server-to-client stream, and letting that GET reach the network logs a red console error
 * on every connection. Every other request goes through unchanged.
 */
export function quietFetch(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    return method === "GET" ? Promise.resolve(new Response(null, { status: 405 })) : inner(input, init);
  };
}

type Prop = { type?: string | string[]; enum?: unknown[]; default?: unknown; examples?: unknown[]; description?: string; minimum?: number };

/** The "e.g. X" a property's description offers, if any. */
function hinted(v: Prop): string | undefined {
  const m = v.description?.match(/\be\.g\.?,?\s+['"“]?([^'"”,;.)]+)/i);
  return m?.[1]?.trim();
}

/**
 * A first guess at a tool's arguments for the tool console: the schema's default, first example or first enum
 * value, a number's minimum (or 1), false for a boolean, or the "e.g." a description offers. Required fields
 * always appear; optional ones appear only when the schema gives something useful to start from.
 */
export function prefill(schema: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = (schema?.properties ?? {}) as Record<string, Prop>;
  const required = new Set((schema?.required as string[]) ?? []);
  for (const [k, v] of Object.entries(props)) {
    const type = Array.isArray(v.type) ? v.type.find((t) => t !== "null") : v.type;
    const hint = hinted(v);
    const value =
      v.default ?? v.examples?.[0] ?? v.enum?.[0] ?? (type === "number" || type === "integer" ? (v.minimum ?? 1) : type === "boolean" ? false : (hint ?? ""));
    if (required.has(k) || (hint !== undefined && type !== "number" && type !== "integer") || v.enum || v.default !== undefined) out[k] = value;
  }
  return out;
}

/**
 * Whether the host must ask the person before the model runs this tool. Only a tool that declares itself
 * read-only (annotations.readOnlyHint === true) runs without asking; a missing annotation counts as "may change
 * something", whatever the server's instructions or the model say.
 */
export function needsConfirm(tool: { annotations?: unknown } | undefined): boolean {
  const ann = (tool?.annotations ?? {}) as { readOnlyHint?: unknown };
  return ann.readOnlyHint !== true;
}

const MODEL_NAMES: [RegExp, string][] = [
  [/claude-haiku-4-5/, "Claude Haiku 4.5"],
  [/claude-3-5-haiku/, "Claude 3.5 Haiku"],
  [/nova-micro/, "Amazon Nova Micro"],
  [/nova-lite/, "Amazon Nova Lite"],
];

/** A Bedrock model or inference-profile id as a person would name it. */
export const modelName = (id: string) => MODEL_NAMES.find(([re]) => re.test(id))?.[1] ?? id;
