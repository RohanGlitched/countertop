// AWS Lambda entry point for Countertop's model function. api/turn.mjs is written for Vercel's Node.js
// (req, res) style; this turns a Lambda Function URL event (payload 2.0) into that shape and the result back,
// so the same file runs on both. The only route is /api/turn (GET: is the model reachable; POST: one turn).
import turn from "../api/turn.mjs";

export function toReq(event) {
  const headers = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) headers[k.toLowerCase()] = v;
  const raw = event.body ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8").toString("utf8") : "";
  return { method: event.requestContext?.http?.method ?? "GET", url: (event.rawPath || "/") + (event.rawQueryString ? `?${event.rawQueryString}` : ""), headers, body: raw };
}

export function makeRes() {
  const out = { statusCode: 200, headers: {}, body: "" };
  const res = {
    status(code) {
      out.statusCode = code;
      return res;
    },
    setHeader(k, v) {
      out.headers[k.toLowerCase()] = String(v);
      return res;
    },
    json(obj) {
      out.headers["content-type"] = "application/json; charset=utf-8";
      out.body = JSON.stringify(obj);
      return res;
    },
    end(text) {
      if (text !== undefined) out.body = String(text);
      return res;
    },
  };
  return { res, out };
}

export async function handler(event) {
  const req = toReq(event);
  const path = event.rawPath || "/";
  if (path !== "/api/turn") return { statusCode: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "Not found." }) };
  const { res, out } = makeRes();
  try {
    await turn(req, res);
  } catch (e) {
    console.error("turn", e);
    return { statusCode: 500, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: "The model function failed. The tool console still works." }) };
  }
  return out;
}
