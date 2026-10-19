/**
 * A real HTTP server around `handle(Request) => Response`, wired the way Next's Node server wires a route handler:
 *  - the request body is a stream (never buffered by the adapter), `request.signal` aborts when the client connection
 *    closes before the response finished,
 *  - response headers go out with the first body chunk, the body is piped with back-pressure,
 *  - if the response body stream ERRORS the connection is destroyed (Next: `writer.abort -> res.destroy(err)`),
 *  - if the client goes away the body stream is cancelled.
 * Used by the fidelity / chaos tests so the CLIENT-visible behaviour (clean end vs. broken connection) is observed
 * on a real socket instead of inferred from `Response` objects.
 */
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { handle } from "@/gateway/handle";

export interface GatewayServer {
  server: http.Server;
  port: number;
  url: string;
  /** requests currently being served */
  active(): number;
  close(): Promise<void>;
}

export async function startGatewayServer(): Promise<GatewayServer> {
  let active = 0;
  const server = http.createServer((req, res) => {
    active++;
    let finished = false;
    res.on("close", () => {
      active--;
      finished = true;
    });
    void serve(req, res, () => finished).catch(() => {
      if (!res.destroyed) res.destroy();
    });
  });
  server.keepAliveTimeout = 620_000;
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    active: () => active,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function serve(req: http.IncomingMessage, res: http.ServerResponse, closed: () => boolean): Promise<void> {
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort(new Error("client disconnected"));
  });
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal: ac.signal };
  if (method !== "GET" && method !== "HEAD") {
    // exactly what Next does: the Node request is handed to `new Request()` as an async iterable body, which undici
    // consumes PULL-based (the TCP window closes while nobody reads) and destroys when the reader cancels
    init.body = req as unknown as BodyInit;
    init.duplex = "half";
  }
  const response = await handle(new Request(`http://${req.headers.host ?? "gateway.test"}${req.url}`, init));

  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.appendHeader(name, value);
  });
  if (!response.body || method === "HEAD") {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => {
    if (!res.writableFinished) reader.cancel(new Error("client disconnected")).catch(() => undefined);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (closed()) return;
      if (!res.write(value)) await Promise.race([once(res, "drain"), once(res, "close")]);
    }
    res.end();
  } catch (err) {
    // the response body errored: drop the connection (no clean end of any kind)
    res.destroy(err instanceof Error ? err : undefined);
  }
}
