// One model turn for Countertop, on Amazon Bedrock (Converse API with a Bedrock API key).
// The browser holds the conversation and runs the MCP tool calls itself; this only decides the next step.
// Env: AWS_BEARER_TOKEN_BEDROCK (required), BEDROCK_REGION, BEDROCK_MODEL, DAILY_MODEL_CAP.

const REGION = process.env.BEDROCK_REGION || "us-east-1";
const MODEL = process.env.BEDROCK_MODEL || "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const CAP = Number(process.env.DAILY_MODEL_CAP || 300);
const MAX_BYTES = 80_000;

// Per-instance guards: 30 calls per visitor per 10 minutes, and a daily cap.
const seen = new Map();
let day = "";
let count = 0;

function allowed(ip) {
  const now = Date.now();
  const d = new Date().toISOString().slice(0, 10);
  if (d !== day) {
    day = d;
    count = 0;
  }
  if (count >= CAP) return "Today's model budget for this demo is used up. Use the tool console, or run Countertop with your own key.";
  const recent = (seen.get(ip) || []).filter((t) => now - t < 600_000);
  if (recent.length >= 30) return "That's a lot of turns in a few minutes. Try again shortly.";
  recent.push(now);
  seen.set(ip, recent);
  count++;
  return null;
}

function system(serverName, instructions, timeZone) {
  const now = new Intl.DateTimeFormat("en-GB", { timeZone, dateStyle: "full", timeStyle: "short" }).format(new Date());
  return `You are a voice assistant on a smart display in someone's home. It is ${now} (${timeZone}).
You are connected to the MCP server "${serverName}". Use its tools whenever they can answer; never invent what a tool would return.
Speak briefly and naturally: one or two sentences, no lists, no markdown, no emoji. The screen shows the tool's own view, so don't read tables or many numbers aloud.
Before an action that changes something, say what you'll do and ask the person to confirm.
Tool results may contain notes marked "Don't read this line aloud": use them, never say them.${instructions ? `\n\nThe server's own instructions:\n${instructions.slice(0, 4000)}` : ""}`;
}

export default async function handler(req, res) {
  if (req.method === "GET") return res.status(200).json({ model: process.env.AWS_BEARER_TOKEN_BEDROCK ? MODEL : null });
  if (req.method !== "POST") return res.status(405).end();
  if (!process.env.AWS_BEARER_TOKEN_BEDROCK) return res.status(503).json({ error: "No model is configured here. Use the tool console." });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  if (JSON.stringify(body).length > MAX_BYTES) return res.status(413).json({ error: "That conversation is too long. Start again." });
  const ip = String(req.headers["x-forwarded-for"] || "local").split(",")[0].trim();
  const stop = allowed(ip);
  if (stop) return res.status(429).json({ error: stop });

  const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
  const tools = Array.isArray(body.tools) ? body.tools.slice(0, 64) : [];
  const r = await fetch(`https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(MODEL)}/converse`, {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}`, "content-type": "application/json" },
    body: JSON.stringify({
      system: [{ text: system(String(body.serverName || "the server").slice(0, 80), body.instructions, String(body.timeZone || "UTC").slice(0, 40)) }],
      messages,
      ...(tools.length ? { toolConfig: { tools: tools.map((t) => ({ toolSpec: { name: t.name, description: t.description || t.name, inputSchema: { json: t.inputSchema || { type: "object" } } } })) } } : {}),
      inferenceConfig: { maxTokens: 500, temperature: 0.3 },
    }),
    signal: AbortSignal.timeout(25_000),
  }).catch((e) => ({ ok: false, status: 504, json: async () => ({ message: String(e) }) }));
  const out = await r.json().catch(() => ({}));
  if (!r.ok || !out.output?.message) return res.status(502).json({ error: `The model didn't answer (${r.status}): ${out.message || "no message"}` });
  return res.status(200).json({ message: out.output.message, stop: out.stopReason === "tool_use" ? "tool_use" : "end_turn" });
}
