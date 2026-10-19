import { Agent, fetch as undiciFetch } from "undici";

/**
 * Shared upstream HTTP client (PLAN 9d.4): ONE undici Agent per protocol flavour for every provider.
 *
 *  - keep-alive on every upstream connection (`keepAliveTimeout` 60s, up to 600s when the server hints more) plus TCP
 *    keep-alive probes (`keepAliveInitialDelay` 30s), so idle pooled sockets and silent long streams are not dropped
 *    by NATs / load balancers in between;
 *  - `connections: 10000` per origin (effectively unbounded: our slot pools bound concurrency), `pipelining: 1`
 *    (= keep-alive without HTTP/1.1 pipelining; 0 would DISABLE it);
 *  - connect timeout 15s;
 *  - undici's own `headersTimeout` / `bodyTimeout` are DISABLED (0): they are agent-wide. We enforce
 *    `provider.timeoutMs` per request (time to response headers, counted from the END of the request upload) and never
 *    kill a slow-but-alive stream (`bodyTimeout: 0`); an optional per-provider idle cutoff lives in the stream layer;
 *  - the h2 flavour (`allowH2`, ALPN-negotiated on https origins) is opt-in per provider, see `wantsHttp2`.
 */
const g = globalThis as unknown as { __ppAgent?: Agent; __ppAgentH2?: Agent };

function agentOptions(allowH2: boolean): ConstructorParameters<typeof Agent>[0] {
  return {
    // One upstream origin (api.openai.com ...) can carry thousands of concurrent streams from one instance: the real
    // concurrency limits are our slot pools. A low undici cap here would silently QUEUE streams behind the first batch
    // (found by the 1000-stream chaos run: half of them started only when the first 512 had finished).
    connections: 10_000,
    pipelining: 1,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 600_000,
    headersTimeout: 0,
    bodyTimeout: 0,
    connect: { timeout: 15_000, keepAlive: true, keepAliveInitialDelay: 30_000 },
    allowH2,
  };
}

export function getAgent(http2 = false): Agent {
  if (http2) return (g.__ppAgentH2 ??= new Agent(agentOptions(true)));
  return (g.__ppAgent ??= new Agent(agentOptions(false)));
}

/** Providers that opt in with `settings.http2 = true` talk HTTP/2 (multiplexed, one kept-alive connection) to https upstreams. */
export function wantsHttp2(provider: { baseUrl: string; settings: Record<string, unknown> }): boolean {
  return provider.settings.http2 === true && /^https:/i.test(provider.baseUrl);
}

export class ClientAbortError extends Error {
  constructor() {
    super("client aborted");
    this.name = "ClientAbortError";
  }
}

export class UpstreamTimeoutError extends Error {
  constructor(readonly phase: "headers" | "idle") {
    super(`upstream timeout (${phase})`);
    this.name = "UpstreamTimeoutError";
  }
}

export type UpstreamBody = string | Uint8Array | ReadableStream<Uint8Array> | null;

export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Streams are sent chunked/with the given content-length (`duplex: "half"`, no body timeout); uploads of any size work. */
  body?: UpstreamBody;
  /** Provider.timeoutMs: max wait for response headers (counted from the END of the request body). */
  timeoutMs: number;
  /** Client disconnect signal. */
  clientSignal?: AbortSignal;
  /** Use the HTTP/2-capable agent. */
  http2?: boolean;
}

export type UpstreamResponse = Awaited<ReturnType<typeof undiciFetch>>;

export interface UpstreamHandle {
  res: UpstreamResponse;
  /** Abort the in-flight request / body stream (client gone, idle timeout...): the upstream connection is destroyed. */
  abort(reason?: unknown): void;
  /** The abort signal so stream readers can classify errors. */
  signal: AbortSignal;
  /** Remove listeners/timers (call when the response is fully consumed or abandoned). */
  dispose(): void;
}

/** Pass `body` through a reader that reports when the source is exhausted (the upload is complete). */
function watchBody(src: ReadableStream<Uint8Array>, onEnd: () => void): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      const r = await reader.read();
      if (r.done) {
        c.close();
        onEnd();
      } else c.enqueue(r.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/**
 * Send one upstream request. Resolves when response HEADERS arrive. Rejects with ClientAbortError,
 * UpstreamTimeoutError, or the underlying network error. Always asks for `Accept-Encoding: identity` (PLAN 5c).
 */
export async function sendUpstream(req: UpstreamRequest): Promise<UpstreamHandle> {
  const ac = new AbortController();
  const onClientAbort = () => ac.abort(new ClientAbortError());
  if (req.clientSignal) {
    if (req.clientSignal.aborted) throw new ClientAbortError();
    req.clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }
  let headerTimer: NodeJS.Timeout | null = null;
  const armHeaderTimer = () => {
    if (headerTimer) clearTimeout(headerTimer);
    headerTimer = setTimeout(() => ac.abort(new UpstreamTimeoutError("headers")), req.timeoutMs);
  };
  const dispose = () => {
    if (headerTimer) clearTimeout(headerTimer);
    headerTimer = null;
    req.clientSignal?.removeEventListener("abort", onClientAbort);
  };

  const isStream = !!req.body && typeof req.body === "object" && !(req.body instanceof Uint8Array);
  let body: string | Uint8Array | ReadableStream<Uint8Array> | undefined;
  if (isStream) body = watchBody(req.body as ReadableStream<Uint8Array>, armHeaderTimer);
  else {
    body = (req.body ?? undefined) as string | Uint8Array | undefined;
    armHeaderTimer();
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (k.toLowerCase() !== "accept-encoding") headers[k] = v;
  headers["accept-encoding"] = "identity";

  try {
    const init: Record<string, unknown> = {
      method: req.method,
      headers,
      body,
      signal: ac.signal,
      dispatcher: getAgent(req.http2),
      redirect: "manual",
    };
    if (isStream) init.duplex = "half";
    const res = await undiciFetch(req.url, init as Parameters<typeof undiciFetch>[1]);
    if (headerTimer) clearTimeout(headerTimer);
    headerTimer = null;
    return { res, abort: (reason) => ac.abort(reason ?? new ClientAbortError()), signal: ac.signal, dispose };
  } catch (err) {
    dispose();
    if (ac.signal.aborted && ac.signal.reason instanceof Error) throw ac.signal.reason;
    throw err;
  }
}

/** Read a response body fully as text with a size cap (throws on overflow). */
export async function readTextLimited(res: UpstreamResponse, maxBytes: number): Promise<string> {
  return (await readBytesLimited(res, maxBytes)).toString("utf8");
}

/** Read a response body fully as bytes with a size cap. */
export async function readBytesLimited(res: UpstreamResponse, maxBytes: number): Promise<Buffer> {
  const body = res.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      reader.cancel().catch(() => undefined);
      throw new Error(`upstream body exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** Best-effort text read for error bodies (never throws). */
export async function readErrorBody(res: UpstreamResponse, maxBytes = 65_536): Promise<string> {
  try {
    const body = res.body;
    if (!body) return "";
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
    }
    reader.cancel().catch(() => undefined);
    return Buffer.concat(chunks).toString("utf8").slice(0, maxBytes);
  } catch {
    return "";
  }
}
