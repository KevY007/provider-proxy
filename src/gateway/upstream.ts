import { Agent, fetch as undiciFetch } from "undici";

/**
 * Shared upstream HTTP client: ONE undici Agent for every provider (keep-alive pool, high per-origin connection
 * count), with timeouts and client-abort propagation managed here per request.
 *
 * `pipelining: 1` (undici default) = keep-alive without HTTP/1.1 pipelining; `0` would DISABLE keep-alive.
 * undici's own headers/body timeouts are disabled (0) because they are agent-wide - we enforce
 * provider.timeoutMs per request (time-to-headers) and per stream (idle gap between chunks).
 */
const g = globalThis as unknown as { __ppAgent?: Agent };

export function getAgent(): Agent {
  if (!g.__ppAgent) {
    g.__ppAgent = new Agent({
      connections: 512,
      pipelining: 1,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 600_000,
      headersTimeout: 0,
      bodyTimeout: 0,
      connect: { timeout: 10_000 },
    });
  }
  return g.__ppAgent;
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

export interface UpstreamRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array | null;
  /** Provider.timeoutMs: max wait for response headers. */
  timeoutMs: number;
  /** Client disconnect signal. */
  clientSignal?: AbortSignal;
}

export type UpstreamResponse = Awaited<ReturnType<typeof undiciFetch>>;

export interface UpstreamHandle {
  res: UpstreamResponse;
  /** Abort the in-flight request / body stream (client gone, idle timeout...). */
  abort(reason?: unknown): void;
  /** The abort signal so stream readers can classify errors. */
  signal: AbortSignal;
  /** Remove listeners/timers (call when the response is fully consumed or abandoned). */
  dispose(): void;
}

/**
 * Send one upstream request. Resolves when response HEADERS arrive. Rejects with ClientAbortError,
 * UpstreamTimeoutError, or the underlying network error.
 */
export async function sendUpstream(req: UpstreamRequest): Promise<UpstreamHandle> {
  const ac = new AbortController();
  const onClientAbort = () => ac.abort(new ClientAbortError());
  if (req.clientSignal) {
    if (req.clientSignal.aborted) throw new ClientAbortError();
    req.clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }
  const headerTimer = setTimeout(() => ac.abort(new UpstreamTimeoutError("headers")), req.timeoutMs);
  const dispose = () => {
    clearTimeout(headerTimer);
    req.clientSignal?.removeEventListener("abort", onClientAbort);
  };
  try {
    const res = await undiciFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body ?? undefined,
      signal: ac.signal,
      dispatcher: getAgent(),
      redirect: "manual",
    });
    clearTimeout(headerTimer);
    return { res, abort: (reason) => ac.abort(reason ?? new ClientAbortError()), signal: ac.signal, dispose };
  } catch (err) {
    dispose();
    if (ac.signal.aborted && ac.signal.reason instanceof Error) throw ac.signal.reason;
    throw err;
  }
}

/** Read a response body fully as text with a size cap (throws on overflow). */
export async function readTextLimited(res: UpstreamResponse, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) return "";
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
  return Buffer.concat(chunks).toString("utf8");
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
