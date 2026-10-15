import { test } from "node:test";
import assert from "node:assert/strict";
import { modelName, needsConfirm, prefill, quietFetch } from "../src/core";

test("quietFetch answers the optional GET stream locally and passes everything else through", async () => {
  const seen: string[] = [];
  const inner = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${String(input)}`);
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const f = quietFetch(inner);
  const get = await f("https://example.test/mcp", { method: "GET", headers: { accept: "text/event-stream" } });
  assert.equal(get.status, 405);
  assert.equal((await f("https://example.test/mcp")).status, 405); // no init means GET
  assert.equal((await f(new Request("https://example.test/mcp"))).status, 405); // a Request object's own method
  assert.equal(seen.length, 0, "no GET reaches the network");
  const post = await f("https://example.test/mcp", { method: "POST", body: "{}" });
  assert.equal(post.status, 200);
  assert.deepEqual(seen, ["POST https://example.test/mcp"]);
  assert.equal((await f("https://example.test/mcp", { method: "delete" })).status, 200, "DELETE (session end) is not swallowed");
});

test("prefill: required fields always, optional ones only when the schema suggests a value", () => {
  // The shape of Lowtide's plan_appliance schema.
  const schema = {
    type: "object",
    properties: {
      appliance: { type: "string", description: "What to run, e.g. dishwasher, washing machine" },
      goal: { type: "string", enum: ["cheapest", "greenest", "balanced"] },
      finish_by: { type: "string", description: "Deadline as a clock time" },
      kwh: { type: "number", minimum: 0.1 },
      place: { type: "string", description: "UK postcode (e.g. SW1A 2AA), 'Chicago' or 'Germany'" },
    },
    required: ["appliance"],
  };
  assert.deepEqual(prefill(schema), { appliance: "dishwasher", goal: "cheapest", place: "SW1A 2AA" });
});

test("prefill: defaults, examples, numbers, booleans and nullable types", () => {
  const schema = {
    type: "object",
    properties: {
      a: { type: "string", default: "x" },
      b: { type: "string", examples: ["first", "second"] },
      n: { type: "integer", minimum: 5 },
      m: { type: "number" },
      flag: { type: "boolean" },
      maybe: { type: ["number", "null"], minimum: 2 },
      free: { type: "string" },
    },
    required: ["b", "n", "m", "flag", "maybe", "free"],
  };
  assert.deepEqual(prefill(schema), { a: "x", b: "first", n: 5, m: 1, flag: false, maybe: 2, free: "" });
  assert.deepEqual(prefill(undefined), {});
  assert.deepEqual(prefill({ type: "object" }), {});
});

test("confirm gate: only a tool that declares itself read-only runs without asking", () => {
  assert.equal(needsConfirm({ annotations: { readOnlyHint: true } }), false);
  assert.equal(needsConfirm({ annotations: { readOnlyHint: false } }), true);
  assert.equal(needsConfirm({ annotations: { destructiveHint: false } }), true, "not destructive is not read-only");
  assert.equal(needsConfirm({ annotations: { readOnlyHint: "true" } }), true, "a string is not a declaration");
  assert.equal(needsConfirm({}), true);
  assert.equal(needsConfirm(undefined), true, "an unknown tool asks");
});

test("model ids read as names", () => {
  assert.equal(modelName("apac.amazon.nova-micro-v1:0"), "Amazon Nova Micro");
  assert.equal(modelName("us.amazon.nova-lite-v1:0"), "Amazon Nova Lite");
  assert.equal(modelName("some.other-model"), "some.other-model");
});
