#!/usr/bin/env node
/**
 * Minimal HTTP/2 cleartext (prior knowledge) client for checking a running ProviderProxy container - the same thing
 * `curl --http2-prior-knowledge` does, for machines whose curl has no HTTP/2:
 *
 *   node scripts/h2c-check.mjs http://127.0.0.1:8080 /api/healthz
 *   node scripts/h2c-check.mjs http://127.0.0.1:8080 /v1/chat/completions --post '{"model":"x","stream":true,"messages":[...]}' -H 'authorization: Bearer sk-pp-...'
 *
 * Prints the HTTP version marker, the status line, the response headers and the body as it streams (with arrival
 * times, so SSE streaming can be seen). Exit code 0 on a completed response, 1 when the stream broke.
 */
import http2 from "node:http2";

const [base, path = "/", ...rest] = process.argv.slice(2);
if (!base) {
  console.error("usage: h2c-check.mjs <http://host:port> [path] [--post <body>] [-H 'name: value']...");
  process.exit(2);
}
let body = null;
const extra = {};
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--post") body = rest[++i];
  else if (rest[i] === "-H") {
    const [k, ...v] = rest[++i].split(":");
    extra[k.trim().toLowerCase()] = v.join(":").trim();
  }
}

const session = http2.connect(base);
session.on("error", (e) => {
  console.error("connect error:", e.message);
  process.exit(1);
});
const headers = { ":method": body === null ? "GET" : "POST", ":path": path, ...extra };
if (body !== null && !headers["content-type"]) headers["content-type"] = "application/json";
const req = session.request(headers);
const t0 = Date.now();
req.on("response", (h) => {
  console.log(`HTTP/2 ${h[":status"]}  (negotiated: ${session.alpnProtocol ?? "h2c"}, encrypted=${session.encrypted})`);
  for (const [k, v] of Object.entries(h)) if (!k.startsWith(":")) console.log(`${k}: ${v}`);
  console.log("");
});
req.on("data", (c) => process.stdout.write(`[+${Date.now() - t0}ms] ${c.toString("utf8")}`));
req.on("end", () => {
  console.log(`\n-- stream ended cleanly after ${Date.now() - t0} ms`);
  session.close();
});
req.on("error", (e) => {
  console.log(`\n-- stream error after ${Date.now() - t0} ms: ${e.code ?? ""} ${e.message}`);
  session.destroy();
  process.exitCode = 1;
});
if (body !== null) req.end(body);
else req.end();
