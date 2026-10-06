// AWS Signature Version 4 for one JSON POST to Bedrock Runtime, for accounts whose organisation policy blocks
// Bedrock API keys (bedrock:CallWithBearerToken) but allows ordinary IAM credentials.
import { createHash, createHmac } from "node:crypto";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key, s) => createHmac("sha256", key).update(s, "utf8").digest();

export function sigv4Headers(url, body, region, keyId, secret, now = new Date()) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const payload = sha256(body);
  const headers = { "content-type": "application/json", host: u.host, "x-amz-content-sha256": payload, "x-amz-date": amzDate };
  const names = Object.keys(headers).sort();
  // every path segment is encoded once more for the canonical request (all services except S3)
  const path = u.pathname.split("/").map((seg) => encodeURIComponent(seg)).join("/");
  const canonical = ["POST", path, "", names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), payload].join("\n");
  const scope = `${day}/${region}/bedrock/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), "bedrock"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  const { host: _host, ...rest } = headers;
  return { ...rest, authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}
