/**
 * Countertop's real MCP host code against a real (in-process) stateless MCP server: the global fetch is routed to
 * the server's handler, so the test sees every request the browser would send.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import { callTool, connect, hasView } from "../src/host";

const VIEW = "ui://test/view.html";
function server() {
  const s = new McpServer({ name: "Kitchen", version: "1.0.0" }, { instructions: "Answer briefly." });
  s.registerTool(
    "get_price",
    { description: "Price now", inputSchema: z.object({ place: z.string() }), annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: VIEW } } },
    async ({ place }) => ({ content: [{ type: "text", text: `Cheap in ${place}.` }] }),
  );
  s.registerTool("save", { description: "Saves", inputSchema: z.object({}) }, async () => {
    throw new Error("Nothing to save.");
  });
  return s;
}
const handler = createMcpHandler(() => server());

const seen: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  seen.push(req.method);
  if (!req.url.startsWith("https://kitchen.test/")) return new Response("no network in tests", { status: 599 });
  return handler.fetch(req);
}) as typeof fetch;

test("host: connects over Streamable HTTP, reads tools, name and instructions, and never sends the GET stream", async () => {
  const conn = await connect("https://kitchen.test/mcp");
  assert.equal(conn.name, "Kitchen");
  assert.equal(conn.instructions, "Answer briefly.");
  assert.deepEqual(conn.tools.map((t) => t.name).sort(), ["get_price", "save"]);
  assert.ok(seen.length > 0 && seen.every((m) => m === "POST"), `only POSTs reach the server: ${seen.join(",")}`);
  await conn.client.close();
});

test("host: knows which tools draw a view", async () => {
  const conn = await connect("https://kitchen.test/mcp");
  assert.equal(hasView(conn, "get_price"), true);
  assert.equal(hasView(conn, "save"), false);
  assert.equal(hasView(conn, "missing"), false);
  await conn.client.close();
});

test("host: a tool result comes back as is, and a tool that throws becomes an error result, not an exception", async () => {
  const conn = await connect("https://kitchen.test/mcp");
  const ok = await callTool(conn, "get_price", { place: "Leeds" });
  assert.equal(ok.isError ?? false, false);
  assert.deepEqual(ok.content, [{ type: "text", text: "Cheap in Leeds." }]);
  const bad = await callTool(conn, "save", {});
  assert.equal(bad.isError, true);
  assert.match((bad.content[0] as { text: string }).text, /Nothing to save/);
  const unknown = await callTool(conn, "nope", {});
  assert.equal(unknown.isError, true);
  await conn.client.close();
});
