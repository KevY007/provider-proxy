/**
 * Production entry point: Next's standalone server, served over HTTP/1.1 AND cleartext HTTP/2 (h2c) on ONE port
 * (PLAN 9d / 5c).
 *
 * Why: Cloud Run caps HTTP/1 request bodies at 32 MB and only an end-to-end HTTP/2 (`--use-http2`) deployment lifts
 * that limit (uploads of hundreds of MB through the Files APIs / multipart endpoints). Local tools, health probes and
 * `docker run` clients still speak HTTP/1.1, so the listener sniffs the first bytes of every connection:
 * "PRI * HTTP/2.0" (the h2c prior-knowledge preface) -> node:http2, anything else -> node:http.
 *
 * It also:
 *  - disables the HTTP/1 request timeout (a slow 1 GB upload must never be cut at 5 minutes), keeps idle HTTP/1
 *    connections alive for KEEP_ALIVE_TIMEOUT (620 s > Google's 600 s load-balancer idle timeout) and sets the headers
 *    timeout above it,
 *  - turns on TCP keep-alive probes and a large HTTP/2 flow-control window (default 64 KB would throttle uploads),
 *  - drains gracefully on SIGTERM: stop accepting, let in-flight requests/streams finish (bounded by
 *    SHUTDOWN_DRAIN_SECONDS, default 600), then exit - src/gateway/meter-writer.ts flushes buffered usage on exit.
 *
 * It wraps the generated ./server.js (Next standalone) by handing Next an http server of our own, so the Next config
 * baked into that file stays the single source of truth.
 */
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { Duplex } from "node:stream";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const origCreateServer = http.createServer;

const SOCKET_IP = process.env.TRUSTED_PROXY_HOPS?.trim() === "0";
/** Open TCP connections per instance (slowloris / idle-connection exhaustion); 0 = unlimited. */
const MAX_CONNECTIONS = Number.parseInt(process.env.MAX_CONNECTIONS ?? "", 10) >= 0 && process.env.MAX_CONNECTIONS ? Number.parseInt(process.env.MAX_CONNECTIONS, 10) : 20_000;
/** A new connection must send its first bytes within this time (protocol sniffing; idle sockets are slowloris). */
const FIRST_BYTES_MS = 15_000;
const KEEP_ALIVE_MS = Number.parseInt(process.env.KEEP_ALIVE_TIMEOUT ?? "", 10) > 0 ? Number.parseInt(process.env.KEEP_ALIVE_TIMEOUT, 10) : 620_000;
const DRAIN_MS = (Number.parseInt(process.env.SHUTDOWN_DRAIN_SECONDS ?? "", 10) > 0 ? Number.parseInt(process.env.SHUTDOWN_DRAIN_SECONDS, 10) : 600) * 1000;
const H2_WINDOW = Number.parseInt(process.env.H2_INITIAL_WINDOW_BYTES ?? "", 10) > 0 ? Number.parseInt(process.env.H2_INITIAL_WINDOW_BYTES, 10) : 1024 * 1024;

let draining = false;
let active = 0;
const sessions = new Set();

/** A Duplex that first yields `head` (bytes already read off `socket`), then everything else from it; writes go to the socket. */
function replaySocket(socket, head) {
  let started = false;
  const d = new Duplex({
    allowHalfOpen: true,
    read() {
      if (!started) {
        started = true;
        this.push(head);
        socket.on("data", (c) => {
          if (!d.push(c)) socket.pause();
        });
        socket.on("end", () => d.push(null));
      }
      socket.resume();
    },
    write(chunk, enc, cb) {
      socket.write(chunk, enc, cb);
    },
    final(cb) {
      socket.end();
      cb();
    },
    destroy(err, cb) {
      socket.destroy(err ?? undefined);
      cb(err);
    },
  });
  socket.on("error", (e) => d.destroy(e));
  socket.on("close", () => d.destroy());
  d.remoteAddress = socket.remoteAddress;
  d.remotePort = socket.remotePort;
  d.remoteFamily = socket.remoteFamily;
  d.localAddress = socket.localAddress;
  d.localPort = socket.localPort;
  d.encrypted = false;
  d.setTimeout = (ms, cb) => socket.setTimeout(ms, cb);
  d.setNoDelay = (v) => socket.setNoDelay(v);
  d.setKeepAlive = (v, ms) => socket.setKeepAlive(v, ms);
  d.ref = () => socket.ref();
  d.unref = () => socket.unref();
  return d;
}

// SEARCH_INDEXING=off (per deployment, read at start): every page answers X-Robots-Tag noindex. Gateway paths are left
// alone (responses there are passed through 1:1, and they are API responses behind a key anyway).
const NO_INDEX = /^(off|false|0|no)$/i.test(process.env.SEARCH_INDEXING ?? "");
const API_PATH = /^\/(v1|v1beta|upload)(\/|$|\?)/;

/** Next calls `http.createServer(listener)` exactly once: give it our dual-protocol server instead. */
function createDualServer(listener) {
  const wrapped = (req, res) => {
    active++;
    // nothing in front of the app (TRUSTED_PROXY_HOPS=0): the socket address is the client, whatever the client sent
    if (SOCKET_IP) req.headers["x-forwarded-for"] = req.socket?.remoteAddress ?? "unknown";
    res.once("close", () => active--);
    if (req.httpVersionMajor === 1) {
      if (draining && !res.headersSent) res.setHeader("connection", "close");
    } else {
      // Http2ServerRequest: headers is a null-prototype object with :pseudo headers - Next expects the HTTP/1 shape
      const h = {};
      for (const [k, v] of Object.entries(req.headers)) if (!k.startsWith(":")) h[k] = v;
      if (!h.host && req.headers[":authority"]) h.host = req.headers[":authority"];
      Object.defineProperty(req, "headers", { value: h, configurable: true, enumerable: true, writable: true });
      // HTTP/2 has no status message (Next sets one): swallow it instead of letting Node warn on every response
      Object.defineProperty(res, "statusMessage", { get: () => "", set: () => undefined, configurable: true });
      // Client abort detection. When the client cancels an HTTP/2 stream (RST_STREAM) Node's compat layer emits 'finish' and
      // 'close' with writableFinished === true, and Next only treats a 'close' with writableFinished === false as "client
      // disconnected" - so request.signal would never abort and the upstream request would keep running. Report
      // writableFinished only once the application really ended the response.
      let ended = false;
      const origEnd = res.end.bind(res);
      res.end = (...a) => {
        ended = true;
        return origEnd(...a);
      };
      const proto = Object.getPrototypeOf(res);
      Object.defineProperty(res, "writableFinished", { get: () => ended && Reflect.get(proto, "writableFinished", res), configurable: true });
    }
    if (NO_INDEX && !API_PATH.test(req.url ?? "")) res.setHeader("x-robots-tag", "noindex, nofollow, noarchive");
    listener(req, res);
  };

  const h1 = origCreateServer.call(http, wrapped);
  h1.keepAliveTimeout = KEEP_ALIVE_MS;
  h1.headersTimeout = KEEP_ALIVE_MS + 10_000;
  h1.requestTimeout = 0; // uploads of any size / duration
  h1.timeout = 0;

  const h2 = http2.createServer({ settings: { initialWindowSize: H2_WINDOW, maxConcurrentStreams: 2048 }, maxSessionMemory: 256 }, wrapped);
  h2.timeout = 0;
  h2.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
    if (draining) session.close();
  });
  h2.on("error", (e) => console.error("[server] http2 error", e));

  const front = net.createServer({ pauseOnConnect: true, noDelay: true, keepAlive: true, keepAliveInitialDelay: 30_000 }, (socket) => {
    socket.on("error", () => undefined);
    socket.setTimeout(FIRST_BYTES_MS, () => socket.destroy());
    const chunks = [];
    let have = 0;
    const onData = (buf) => {
      chunks.push(buf);
      have += buf.length;
      if (have < 3) return; // "PRI" needs three bytes
      socket.off("data", onData);
      socket.setTimeout(0);
      socket.pause();
      const head = Buffer.concat(chunks);
      if (head.toString("latin1", 0, 3) === "PRI") {
        // h2c: node:http2 reads the raw socket handle itself, so the bytes we already consumed must be replayed
        h2.emit("connection", replaySocket(socket, head));
      } else {
        socket.unshift(head);
        h1.emit("connection", socket);
        socket.resume();
      }
    };
    socket.on("data", onData);
    socket.resume();
  });

  if (MAX_CONNECTIONS > 0) front.maxConnections = MAX_CONNECTIONS;

  // Next treats `h1` as THE server: make it listen / report / close through the sniffing front.
  h1.listen = (...args) => {
    front.listen(...args);
    return h1;
  };
  h1.address = () => front.address();
  front.on("listening", () => h1.emit("listening"));
  front.on("error", (e) => h1.emit("error", e));
  h1.close = (cb) => {
    front.close();
    cb?.();
    return h1;
  };
  h1.__drain = { front, h1, h2 };
  return h1;
}

http.createServer = function createServer(...args) {
  http.createServer = origCreateServer;
  const listener = args.find((a) => typeof a === "function");
  const server = createDualServer(listener);
  globalThis.__ppServer = server;
  return server;
};

// graceful shutdown: we own SIGTERM/SIGINT (Next's own handler is switched off)
process.env.NEXT_MANUAL_SIG_HANDLE = "1";

function shutdown(signal) {
  if (draining) return;
  draining = true;
  const server = globalThis.__ppServer;
  console.log(JSON.stringify({ severity: "INFO", message: "shutdown: draining", signal, activeRequests: active, http2Sessions: sessions.size, drainSeconds: DRAIN_MS / 1000 }));
  server?.__drain.front.close();
  server?.closeIdleConnections?.();
  for (const s of sessions) s.close(); // GOAWAY: no new streams, open streams run to completion
  const started = Date.now();
  const timer = setInterval(() => {
    server?.closeIdleConnections?.();
    if (active === 0 || Date.now() - started > DRAIN_MS) {
      clearInterval(timer);
      console.log(JSON.stringify({ severity: "INFO", message: "shutdown: exiting", activeRequests: active, forced: active > 0 }));
      server?.closeAllConnections?.();
      for (const s of sessions) s.destroy();
      // the usage buffer is flushed by the exit hook of the metering writer
      process.exit(signal === "SIGINT" ? 130 : 143);
    }
  }, 100);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

require("./server.js");
