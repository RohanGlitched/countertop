/** The AWS Lambda entry point and the role credentials, without calling AWS. */
import { test } from "node:test";
import assert from "node:assert/strict";

for (const k of ["BEDROCK_ACCESS_KEY_ID", "BEDROCK_SECRET_ACCESS_KEY", "AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "VERCEL"]) delete process.env[k];
// @ts-expect-error: plain .mjs files without type declarations
const lambda = await import("../infra/lambda.mjs");
// @ts-expect-error: as above
const turn = await import("../api/turn.mjs");
// @ts-expect-error: as above
const { sigv4Headers } = await import("../api/_sigv4.mjs");

const event = (method: string, path: string, headers: Record<string, string> = {}, body?: string) => ({
  version: "2.0",
  rawPath: path,
  rawQueryString: "",
  headers: { host: "abc.lambda-url.ap-southeast-2.on.aws", ...headers },
  requestContext: { http: { method, path } },
  body: body ? Buffer.from(body).toString("base64") : undefined,
  isBase64Encoded: Boolean(body),
});

test("lambda: GET /api/turn says whether a model is configured, other paths are 404", async () => {
  const r = await lambda.handler(event("GET", "/api/turn"));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { model: null, reachable: false });
  assert.equal(r.headers["cache-control"], "no-store");
  assert.equal((await lambda.handler(event("GET", "/api/other"))).statusCode, 404);
});

test("lambda: behind CloudFront the same-origin guard uses x-forwarded-host, and a foreign page is refused", async () => {
  const body = JSON.stringify({ messages: [{ role: "user", content: [{ text: "hi" }] }] });
  const foreign = await lambda.handler(event("POST", "/api/turn", { origin: "https://evil.test", "x-forwarded-host": "d9.cloudfront.net", "content-type": "application/json" }, body));
  assert.equal(foreign.statusCode, 403);
  // our own page gets past the guard; with no credentials here it then says no model is configured
  const own = await lambda.handler(event("POST", "/api/turn", { origin: "https://d9.cloudfront.net", "x-forwarded-host": "d9.cloudfront.net", "content-type": "application/json" }, body));
  assert.equal(own.statusCode, 503);
  assert.match(JSON.parse(own.body).error, /No model is configured/);
});

test("credentials: a Bedrock-only key first, then the Lambda role (with its session token), never Vercel's AWS_* variables", () => {
  const role = { AWS_ACCESS_KEY_ID: "ASIA1", AWS_SECRET_ACCESS_KEY: "s", AWS_SESSION_TOKEN: "t" };
  assert.deepEqual(turn.credentials(role), { id: "ASIA1", secret: "s", session: "t" });
  assert.deepEqual(turn.credentials({ ...role, BEDROCK_ACCESS_KEY_ID: "AKIA2", BEDROCK_SECRET_ACCESS_KEY: "k" }), { id: "AKIA2", secret: "k" });
  assert.equal(turn.credentials({ ...role, VERCEL: "1" }), null);
  assert.equal(turn.credentials({}), null);
});

test("sigv4: a session token is sent and signed (botocore's signature for the same request)", () => {
  const url = "https://bedrock-runtime.ap-southeast-2.amazonaws.com/model/apac.amazon.nova-micro-v1%3A0/converse";
  const body = '{"messages":[{"role":"user","content":[{"text":"ok"}]}]}';
  const h = sigv4Headers(url, body, "ap-southeast-2", "ASIAEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", new Date("2026-10-15T09:11:58Z"), "FwoGZXIvYXdzEXAMPLE//token+with/slashes=");
  assert.equal(h["x-amz-security-token"], "FwoGZXIvYXdzEXAMPLE//token+with/slashes=");
  assert.match(h.authorization, /SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=e8d3c5f7e31483b12e906899443000271d5645fa5d8d8b8c4271be53aeae4bb2$/);
  const plain = sigv4Headers(url, body, "ap-southeast-2", "AKIDEXAMPLE", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", new Date("2026-10-15T09:11:58Z"));
  assert.match(plain.authorization, /Signature=77774c9057c3e385b0371da3c8e798e6161d4364b580b8aa8d2f94532e9a7053$/);
});

test("lambda: a whole POST turn on Lambda answers 200 with the model's message (Bedrock faked), and 502 when Bedrock refuses", async () => {
  // Regression: the turn's log line used a timer from another function, so every real POST threw on AWS.
  const realFetch = globalThis.fetch;
  process.env.AWS_ACCESS_KEY_ID = "ASIAEXAMPLE";
  process.env.AWS_SECRET_ACCESS_KEY = "secret";
  process.env.AWS_SESSION_TOKEN = "token";
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  let reply: Response = Response.json({ output: { message: { role: "assistant", content: [{ text: "<thinking>plan</thinking>Run it at one a.m." }] } }, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } });
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
    return reply;
  }) as typeof fetch;
  const write = process.stdout.write.bind(process.stdout);
  const lines: string[] = [];
  process.stdout.write = ((chunk: string) => (lines.push(String(chunk)), true)) as typeof process.stdout.write;
  try {
    const body = JSON.stringify({ messages: [{ role: "user", content: [{ text: "When should I run the dishwasher?" }] }], tools: [{ name: "plan_appliance", description: "plan", inputSchema: { type: "object" } }], serverName: "Lowtide", timeZone: "Europe/London" });
    const headers = { origin: "https://d9.cloudfront.net", "x-forwarded-host": "d9.cloudfront.net", "content-type": "application/json", "x-forwarded-for": "203.0.113.7" };
    const ok = await lambda.handler(event("POST", "/api/turn", headers, body));
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(JSON.parse(ok.body), { message: { role: "assistant", content: [{ text: "Run it at one a.m." }] }, stop: "end_turn" });
    assert.match(calls[0].url, /bedrock-runtime\.ap-southeast-2\.amazonaws\.com\/model\/apac\.amazon\.nova-micro-v1%3A0\/converse/);
    assert.equal(calls[0].headers["x-amz-security-token"], "token");
    assert.equal(JSON.parse(calls[0].body).toolConfig.tools[0].toolSpec.name, "plan_appliance");
    const logged = JSON.parse(lines.find((l) => l.includes('"evt":"model"'))!);
    assert.equal(logged.ok, true);
    assert.ok(Number.isFinite(logged.ms) && logged.ms >= 0);

    reply = Response.json({ message: "AccessDeniedException" }, { status: 403 });
    const refused = await lambda.handler(event("POST", "/api/turn", headers, body));
    assert.equal(refused.statusCode, 502);
    assert.match(JSON.parse(refused.body).error, /Bedrock said 403/);
  } finally {
    process.stdout.write = write;
    globalThis.fetch = realFetch;
    for (const k of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"]) delete process.env[k];
  }
});
