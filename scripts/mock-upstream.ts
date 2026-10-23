/**
 * Mock upstream: a fake OpenAI / Anthropic / Gemini server for local dev, tests and load tests.
 *
 *   pnpm mock:upstream            # listens on :4010 (MOCK_UPSTREAM_PORT overrides)
 *
 * Programmatic use (tests):
 *   const mock = await startMockUpstream(0);   // ephemeral port
 *   ... mock.port ...
 *   await mock.close();
 *
 * Fault injection (by the upstream credential the gateway presents):
 *   key contains "fail429" -> 429 + retry-after: 2     "fail500" -> 500     "fail529" -> 529 (overloaded)
 *   key contains "bad"     -> 401 invalid key          "slow"    -> +1500ms before responding / first byte
 *   key contains "deny403" -> 403 "this group does not allow" (a reseller key without access to this endpoint; the key itself is fine)
 *   key contains "ftfail"   -> streamed responses carrying `prompt_cache_breakpoint`: a relay backend that does not
 *                              support it (blank " " text, then response.failed invalid_parameter)
 *   key contains "ceflaky"  -> streamed responses: odd requests open like a relay (empty text delta, response.created,
 *                              a vendor codex.rate_limits event) and then fail with a NESTED error {error:{..}, status:503}
 *   key contains "flakystart" -> streamed chat: every other request opens the stream (role-only chunk) and then sends an
 *                             in-band "Service Unavailable" error before any output (the relay failure seen in production)
 * Delay knobs: header `x-mock-delay-ms`, body field `mock_delay_ms`, or marker `[[delay:N]]` in the last user
 * text. Non-stream: wait N ms before responding. Stream: wait N ms before EVERY SSE chunk (holds slots open).
 * Usage override marker (in the last user text / prompt / input): `[[usage:in=1000,out=500,cached=200,cw=50]]`.
 * Long-output markers (funds-guard tests): `[[words:N]]` replies with N words (1 token each) and OBEYS the request's
 * output cap (max_tokens / max_completion_tokens / max_output_tokens / maxOutputTokens), `[[runaway:N]]` replies with
 * N words and IGNORES the cap (a misbehaving upstream). `[[http400]]` anywhere in the request body makes the mock
 * answer a 400 invalid_request.
 * `[[notool]]` suppresses the automatic tool call. Introspection (no auth): /__mock/stats, /__mock/reset,
 * /__mock/last?path=/v1/messages, /__mock/aborts, /healthz.
 *
 * Fidelity / chaos controls (PLAN 9d.6) - header `x-mock-mode` (the gateway forwards `x-mock-*` headers to providers
 * tagged "mock"), comma separated:
 *   drop-headers            RST the connection before any response byte
 *   drop-pre-content        send the response headers, then RST before the first body byte
 *   rst-after:N             RST (TCP reset) after N body frames          fin-after:N   clean FIN after N frames, NO terminator
 *   stall-after:N           stop sending after N frames (connection stays open)
 *   error-after:N           send an in-stream error event after N frames, then end normally
 *   gzip                    compress the response (Content-Encoding: gzip) even though the client asked for identity
 *   early-headers           flush the response headers immediately (before a delayed first frame), like a real provider
 * Header `x-mock-fail: <status>` answers that HTTP status (retry-after: 7 + request id + rate-limit headers, native body).
 * Per-frame delay: `x-mock-delay-ms` (a slow trickle). `x-mock-linger-ms: N` keeps a stream's connection open N ms after its last frame. `x-mock-tag: <id>` labels a request in /__mock/aborts.
 * `x-mock-hash-body: 1` (automatic above 32 MB) never buffers the request: the body is hashed on the fly and
 * /__mock/last reports bodySha256 / bodyBytes. Files APIs (OpenAI /v1/files + /v1/uploads, Anthropic /v1/files,
 * Gemini /upload/v1beta/files + /v1beta/files) keep files per upstream credential (a file is invisible to other keys).
 */
import http from "node:http";
import zlib from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { MultipartScanner, boundaryOf } from "../src/gateway/multipart";

// ---------------------------------------------------------------------------------------------------------------------
// small utils
// ---------------------------------------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;
type Surface = "openai" | "anthropic" | "gemini";

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asStr = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const pick = (o: Obj, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] !== undefined) return o[k];
  return undefined;
};

const rid = () => randomUUID().replace(/-/g, "").slice(0, 20);
const nowSec = () => Math.floor(Date.now() / 1000);
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Split a string into `n` roughly-equal non-empty pieces (used to stream tool-call arguments). */
function splitPieces(s: string, n = 3): string[] {
  const size = Math.max(1, Math.ceil(s.length / n));
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** Deterministic pseudo-embedding in [-1, 1]. */
function embed(text: string, dims = 8): number[] {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < dims; i++) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    out.push(Number(((h / 0xffffffff) * 2 - 1).toFixed(6)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// state & stats
// ---------------------------------------------------------------------------------------------------------------------

interface Counter {
  total: number;
  inflight: number;
  maxInflight: number;
}
interface LastRequest {
  path: string;
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  multipart: { fields: Record<string, string>; files: { name: string; filename: string; size: number }[] } | null;
  /** streamed (never buffered) bodies: hash + size of everything received */
  bodySha256?: string;
  bodyBytes?: number;
  at: string;
}
/** A request that ended before the mock finished answering it (the client / the gateway hung up). */
interface AbortRecord {
  tag: string | null;
  path: string;
  key: string;
  /** what the mock was doing: reading the request body, waiting (delay) or streaming the response */
  phase: "uploading" | "waiting" | "streaming";
  frames: number;
  /** Date.now() at the moment the mock noticed */
  at: number;
}
interface MockFile {
  id: string;
  /** upstream credential that owns it: other keys cannot see it (separate accounts) */
  owner: string;
  api: "openai" | "anthropic" | "gemini";
  filename: string;
  purpose: string;
  mime: string;
  bytes: number;
  sha256: string;
  /** small files keep their content; big ones are regenerated as a pattern on download */
  data: Buffer | null;
  createdAt: number;
  object: Obj;
}
interface MockUpload {
  id: string;
  owner: string;
  filename: string;
  purpose: string;
  mime: string;
  bytes: number;
  parts: Map<string, { size: number; sha256: string }>;
  status: string;
}
interface MockGSession {
  id: string;
  owner: string;
  mime: string;
  displayName: string;
  received: number;
}
interface MockContainerFile {
  owner: string;
  containerId: string;
  id: string;
  filename: string;
  data: Buffer;
  createdAt: number;
}
/** "flakystart" credentials: streamed chat requests seen per credential (odd ones fail before any output). */
const flakyStarts = new Map<string, number>();

interface MockState {
  total: number;
  inflight: number;
  maxInflight: number;
  byKey: Map<string, Counter>;
  byPath: Map<string, number>;
  last: Map<string, LastRequest>;
  responses: Map<string, Obj>;
  aborts: AbortRecord[];
  files: Map<string, MockFile>;
  uploads: Map<string, MockUpload>;
  gsessions: Map<string, MockGSession>;
  /** code-interpreter container files (a Responses request that ran code creates them), by `<container>/<file>` */
  containerFiles: Map<string, MockContainerFile>;
  /** fal / Replicate / video job state (created lazily) */
  extras?: MockExtras;
  /** Anthropic Message Batches + OpenAI Batch jobs, by id */
  batches: Map<string, MockBatch>;
}
interface MockBatch {
  id: string;
  api: "anthropic" | "openai";
  owner: string;
  createdAt: number;
  /** Anthropic: {custom_id, params}; OpenAI: input file lines {custom_id, method, url, body} */
  requests: Obj[];
  endpoint: string;
  inputFileId: string | null;
  polls: number;
  slow: boolean;
  canceled: boolean;
  /** result lines once the batch ended (Anthropic results / OpenAI output + error lines) */
  results: string[] | null;
  errors: string[] | null;
  outputFileId: string | null;
  errorFileId: string | null;
  metadata: Obj | null;
}

function createState(): MockState {
  return {
    total: 0,
    inflight: 0,
    maxInflight: 0,
    byKey: new Map(),
    byPath: new Map(),
    last: new Map(),
    responses: new Map(),
    aborts: [],
    files: new Map(),
    uploads: new Map(),
    gsessions: new Map(),
    containerFiles: new Map(),
    batches: new Map(),
  };
}

function track(state: MockState, key: string, path: string): () => void {
  state.total++;
  state.inflight++;
  state.maxInflight = Math.max(state.maxInflight, state.inflight);
  let c = state.byKey.get(key);
  if (!c) state.byKey.set(key, (c = { total: 0, inflight: 0, maxInflight: 0 }));
  c.total++;
  c.inflight++;
  c.maxInflight = Math.max(c.maxInflight, c.inflight);
  state.byPath.set(path, (state.byPath.get(path) ?? 0) + 1);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    state.inflight = Math.max(0, state.inflight - 1);
    const cur = state.byKey.get(key);
    if (cur) cur.inflight = Math.max(0, cur.inflight - 1);
  };
}

function resetState(state: MockState): void {
  state.total = 0;
  state.maxInflight = state.inflight; // requests still in flight keep being counted
  const keep = new Map<string, Counter>();
  for (const [k, c] of state.byKey) if (c.inflight > 0) keep.set(k, { total: 0, inflight: c.inflight, maxInflight: c.inflight });
  state.byKey = keep;
  state.byPath = new Map();
  state.last = new Map();
  state.responses = new Map();
  state.aborts = [];
  state.files = new Map();
  state.uploads = new Map();
  state.gsessions = new Map();
  state.containerFiles = new Map();
  state.batches = new Map();
  state.extras = undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// request context
// ---------------------------------------------------------------------------------------------------------------------

interface Fault {
  dropHeaders: boolean;
  dropPreContent: boolean;
  rstAfter?: number;
  finAfter?: number;
  stallAfter?: number;
  errorAfter?: number;
  gzip: boolean;
  /** send the response headers right away, before the first (delayed) frame - what a real provider does */
  earlyHeaders?: boolean;
}

interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  path: string;
  surface: Surface;
  closed: boolean;
  waiters: Set<() => void>;
  state: MockState;
  fault: Fault | null;
  phase: "uploading" | "waiting" | "streaming";
  frames: number;
  /** the mock itself cut the connection (not a client abort) */
  selfDestroyed: boolean;
  tag: string | null;
  cred: string;
  /** body received in streaming-hash mode */
  hashed: { sha256: string; bytes: number } | null;
  /** multipart structure of a streamed body (fields + file part sizes) */
  scan: MultipartScanner | null;
}

function parseFault(req: http.IncomingMessage): Fault | null {
  const raw = req.headers["x-mock-mode"];
  const text = Array.isArray(raw) ? raw.join(",") : raw;
  if (!text) return null;
  const f: Fault = { dropHeaders: false, dropPreContent: false, gzip: false };
  for (const part of text.split(",")) {
    const [name, arg] = part.trim().split(":");
    const n = Number(arg);
    switch (name) {
      case "drop-headers":
        f.dropHeaders = true;
        break;
      case "drop-pre-content":
        f.dropPreContent = true;
        break;
      case "rst-after":
        f.rstAfter = Number.isFinite(n) ? n : 1;
        break;
      case "fin-after":
        f.finAfter = Number.isFinite(n) ? n : 1;
        break;
      case "stall-after":
        f.stallAfter = Number.isFinite(n) ? n : 1;
        break;
      case "error-after":
        f.errorAfter = Number.isFinite(n) ? n : 1;
        break;
      case "gzip":
        f.gzip = true;
        break;
      case "early-headers":
        f.earlyHeaders = true;
        break;
      default:
    }
  }
  return f;
}

/** Cut the connection the way a failing provider does: `rst` = TCP reset, `fin` = clean close without the chunked terminator. */
function cutConnection(ctx: Ctx, how: "rst" | "fin"): void {
  ctx.selfDestroyed = true;
  const socket = ctx.res.socket ?? ctx.req.socket;
  if (!socket || socket.destroyed) return;
  if (how === "rst") socket.resetAndDestroy();
  else {
    socket.end();
    setTimeout(() => socket.destroy(), 20).unref?.();
  }
}

/** Write `data` and resolve once it has left the process (so a following RST cannot swallow it). */
function writeFlushed(ctx: Ctx, w: { write(chunk: string | Buffer, cb: (err?: Error | null) => void): boolean }, data: string | Buffer): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ctx.res.destroyed) return resolve();
    w.write(data, () => resolve());
  });
}

/** Cancellable sleep. Resolves false when the client went away (so callers can bail out). */
function sleep(ctx: Ctx, ms: number): Promise<boolean> {
  if (ctx.closed) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const wake = () => {
      clearTimeout(t);
      ctx.waiters.delete(wake);
      resolve(false);
    };
    const t = setTimeout(() => {
      ctx.waiters.delete(wake);
      resolve(true);
    }, ms);
    ctx.waiters.add(wake);
  });
}

function surfaceOf(path: string, req?: http.IncomingMessage): Surface {
  if (path === "/v1/messages" || path.startsWith("/v1/messages/")) return "anthropic";
  if (path === "/v1/files" || path.startsWith("/v1/files/")) return req?.headers["anthropic-version"] ? "anthropic" : "openai";
  if (path === "/v1beta/models" || path.startsWith("/v1beta/models/") || path === "/v1beta/files" || path.startsWith("/v1beta/files/") || path.startsWith("/upload/v1beta/")) return "gemini";
  return "openai";
}

const isIntrospection = (path: string) => path.startsWith("/__mock/") || path === "/healthz";

// ---------------------------------------------------------------------------------------------------------------------
// responses
// ---------------------------------------------------------------------------------------------------------------------

type ErrKind = "auth" | "rate_limit" | "server" | "overloaded" | "invalid_request" | "not_found";
const ERR_STATUS: Record<ErrKind, number> = {
  auth: 401,
  rate_limit: 429,
  server: 500,
  overloaded: 529,
  invalid_request: 400,
  not_found: 404,
};
const OPENAI_ERR: Record<ErrKind, [string, string]> = {
  auth: ["invalid_request_error", "invalid_api_key"],
  rate_limit: ["rate_limit_error", "rate_limit_exceeded"],
  server: ["server_error", "internal_server_error"],
  overloaded: ["server_error", "overloaded"],
  invalid_request: ["invalid_request_error", "invalid_request"],
  not_found: ["invalid_request_error", "not_found"],
};
const ANTHROPIC_ERR: Record<ErrKind, string> = {
  auth: "authentication_error",
  rate_limit: "rate_limit_error",
  server: "api_error",
  overloaded: "overloaded_error",
  invalid_request: "invalid_request_error",
  not_found: "not_found_error",
};
const GEMINI_ERR: Record<ErrKind, string> = {
  auth: "UNAUTHENTICATED",
  rate_limit: "RESOURCE_EXHAUSTED",
  server: "INTERNAL",
  overloaded: "UNAVAILABLE",
  invalid_request: "INVALID_ARGUMENT",
  not_found: "NOT_FOUND",
};

/** Ids every real provider sends; the gateway must rename them to x-upstream-request-id and drop the rest. */
function idHeaders(): Record<string, string> {
  return { "x-request-id": `req_mock_${rid()}`, "openai-organization": "org-mock-secret", "openai-version": "2020-10-01", "x-powered-by": "mock-upstream" };
}

function sendJson(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const res = ctx.res;
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const f = ctx.fault;
  if (f?.dropHeaders || f?.dropPreContent) return cutConnection(ctx, "rst");
  let payload: string | Buffer = JSON.stringify(body);
  const out: Record<string, string | number> = { "content-type": "application/json", ...idHeaders(), ...headers };
  if (f?.gzip) {
    payload = zlib.gzipSync(payload);
    out["content-encoding"] = "gzip";
  }
  out["content-length"] = Buffer.byteLength(payload);
  if (f?.rstAfter !== undefined || f?.finAfter !== undefined) {
    // cut the body in half
    res.writeHead(status, out);
    const half = Buffer.from(payload).subarray(0, Math.max(1, Math.floor(Buffer.byteLength(payload) / 2)));
    void writeFlushed(ctx, res, half).then(() => cutConnection(ctx, f.rstAfter !== undefined ? "rst" : "fin"));
    return;
  }
  res.writeHead(status, out);
  res.end(payload);
}

function sendError(ctx: Ctx, kind: ErrKind, message: string, extraHeaders: Record<string, string> = {}, statusOverride?: number): void {
  const status = statusOverride ?? ERR_STATUS[kind];
  const headers = { ...extraHeaders };
  let body: Obj;
  if (ctx.surface === "anthropic") {
    body = { type: "error", error: { type: ANTHROPIC_ERR[kind], message }, request_id: `req_mock_${rid()}` };
  } else if (ctx.surface === "gemini") {
    body = { error: { code: status, message, status: GEMINI_ERR[kind] } };
  } else {
    const [type, code] = OPENAI_ERR[kind];
    body = { error: { message, type, code, param: null } };
  }
  sendJson(ctx, status, body, headers);
}

function rateLimitHeaders(ctx: Ctx): Record<string, string> {
  const h: Record<string, string> = {
    "retry-after": "2",
    "x-ratelimit-limit-requests": "100",
    "x-ratelimit-remaining-requests": "0",
    "x-ratelimit-reset-requests": "2s",
  };
  if (ctx.surface === "anthropic") {
    h["anthropic-ratelimit-requests-limit"] = "100";
    h["anthropic-ratelimit-requests-remaining"] = "0";
    h["anthropic-ratelimit-requests-reset"] = new Date(Date.now() + 2000).toISOString();
  }
  return h;
}

/**
 * Write frames one by one, sleeping `delay` ms BEFORE each (so slots stay occupied when delay > 0).
 * Headers are sent with the first frame (like a real provider: time-to-first-byte == first delay).
 */
async function emitFrames(ctx: Ctx, frames: string[], delay: number, contentType: string): Promise<void> {
  const res = ctx.res;
  const f = ctx.fault;
  ctx.phase = "waiting";
  if (f?.dropHeaders) return cutConnection(ctx, "rst");
  res.statusCode = 200;
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "no-cache");
  res.setHeader("x-accel-buffering", "no");
  for (const [k, v] of Object.entries(idHeaders())) res.setHeader(k, v);
  const gz = f?.gzip ? zlib.createGzip() : null;
  if (gz) {
    res.setHeader("content-encoding", "gzip");
    gz.pipe(res);
  }
  const put = (data: string): Promise<void> => {
    if (!gz) return writeFlushed(ctx, res, data);
    return new Promise<void>((resolve) => {
      gz.write(data);
      gz.flush(() => resolve());
    });
  };
  if (f?.dropPreContent) {
    res.flushHeaders();
    await sleep(ctx, 40);
    return cutConnection(ctx, "rst");
  }
  if (f?.earlyHeaders) res.flushHeaders();
  for (let i = 0; i < frames.length; i++) {
    if (!(await sleep(ctx, delay))) return;
    if (res.destroyed || res.writableEnded) return;
    ctx.phase = "streaming";
    await put(frames[i]);
    ctx.frames++;
    const n = i + 1;
    // (a TCP reset discards what the peer has not read yet: give the frames written so far time to be consumed)
    if (f?.rstAfter === n) {
      await sleep(ctx, 60);
      return cutConnection(ctx, "rst");
    }
    if (f?.finAfter === n) {
      await sleep(ctx, 30);
      return cutConnection(ctx, "fin");
    }
    if (f?.stallAfter === n) {
      await sleep(ctx, 3_600_000);
      return;
    }
    if (f?.errorAfter === n) {
      await put(streamErrorFrame(ctx));
      if (gz) gz.end();
      else res.end();
      return;
    }
  }
  // `x-mock-linger-ms`: keep the connection open this long after the LAST frame (a real provider closes a moment later than
  // it sent its terminal event - a client that stops reading at [DONE] and hangs up then races the upstream's own end)
  const linger = Number(hdr(ctx.req, "x-mock-linger-ms"));
  if (Number.isFinite(linger) && linger > 0 && !(await sleep(ctx, Math.min(linger, 60_000)))) return;
  if (gz) gz.end();
  else if (!res.destroyed && !res.writableEnded) res.end();
}

/** The in-stream error event each API uses (sent after `error-after:N` frames). */
function streamErrorFrame(ctx: Ctx): string {
  if (ctx.surface === "anthropic") return eventFrame("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" }, request_id: `req_mock_${rid()}` });
  if (ctx.surface === "gemini") return dataFrame({ error: { code: 503, message: "The model is overloaded. Please try again later.", status: "UNAVAILABLE" } });
  if (ctx.path === "/v1/responses") return eventFrame("error", { type: "error", code: "server_error", message: "The server had an error while processing your request.", param: null, sequence_number: 99 });
  return dataFrame({ error: { message: "The server had an error while processing your request.", type: "server_error", code: "server_error", param: null } });
}

const SSE = "text/event-stream";
const dataFrame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const eventFrame = (name: string, o: unknown) => `event: ${name}\ndata: ${JSON.stringify(o)}\n\n`;

// ---------------------------------------------------------------------------------------------------------------------
// body parsing
// ---------------------------------------------------------------------------------------------------------------------

interface Multipart {
  fields: Record<string, string>;
  files: { name: string; filename: string; size: number }[];
}
interface Parsed {
  json: Obj | null;
  multipart: Multipart | null;
}

class BadBody extends Error {}

function parseMultipart(body: Buffer, contentType: string): Multipart {
  const out: Multipart = { fields: {}, files: [] };
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return out;
  const delim = Buffer.from("--" + (m[1] ?? m[2]).trim());
  let pos = body.indexOf(delim);
  while (pos >= 0) {
    const start = pos + delim.length;
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break; // closing delimiter
    const next = body.indexOf(delim, start);
    if (next < 0) break;
    const part = body.subarray(start + 2, Math.max(start + 2, next - 2)); // skip CRLF before headers / after content
    const headEnd = part.indexOf("\r\n\r\n");
    if (headEnd >= 0) {
      const head = part.subarray(0, headEnd).toString("utf8");
      const content = part.subarray(headEnd + 4);
      const name = /name="([^"]*)"/i.exec(head)?.[1] ?? "";
      const filename = /filename="([^"]*)"/i.exec(head)?.[1];
      if (filename !== undefined) out.files.push({ name, filename, size: content.length });
      else out.fields[name] = content.toString("utf8");
    }
    pos = next;
  }
  return out;
}

function parseBody(raw: Buffer, contentType: string): Parsed {
  if (/multipart\/form-data/i.test(contentType)) return { json: null, multipart: parseMultipart(raw, contentType) };
  if (raw.length === 0) return { json: {}, multipart: null };
  let v: unknown;
  try {
    v = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BadBody("We could not parse the JSON body of your request.");
  }
  if (!isObj(v)) throw new BadBody("The request body must be a JSON object.");
  return { json: v, multipart: null };
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------------------------------------------------
// request understanding (markers, text extraction, tool detection, usage)
// ---------------------------------------------------------------------------------------------------------------------

interface Markers {
  in?: number;
  out?: number;
  cached?: number;
  cw?: number;
  delay?: number;
  notool: boolean;
  /** long reply: N words */
  words?: number;
  /** ignore the request's output cap */
  runaway?: boolean;
  /** server tools (Anthropic + Responses): N web searches / file searches, a code-execution run that creates a file */
  ws?: number;
  fs?: number;
  codeexec: boolean;
  /** thinking tokens (inside the output tokens); thinkburn = thinking uses the whole output budget and no text follows */
  think?: number;
  thinkburn: boolean;
  /** do not itemize the thinking tokens in usage (output_tokens_details) */
  nothinkdetails: boolean;
}

function parseMarkers(src: string): Markers {
  const mk: Markers = {
    notool: /\[\[notool\]\]/.test(src),
    codeexec: /\[\[codeexec\]\]/.test(src),
    thinkburn: /\[\[thinkburn\]\]/.test(src),
    nothinkdetails: /\[\[nothinkdetails\]\]/.test(src),
  };
  const ws = /\[\[ws:(\d+)\]\]/.exec(src);
  if (ws) mk.ws = Number(ws[1]);
  const fsm = /\[\[fs:(\d+)\]\]/.exec(src);
  if (fsm) mk.fs = Number(fsm[1]);
  const th = /\[\[think:(\d+)\]\]/.exec(src);
  if (th) mk.think = Number(th[1]);
  const u = /\[\[usage:([^\]]*)\]\]/.exec(src);
  if (u) {
    for (const pair of u[1].split(",")) {
      const [k, v] = pair.split("=").map((s) => s.trim());
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) continue;
      if (k === "in") mk.in = Math.floor(n);
      else if (k === "out") mk.out = Math.floor(n);
      else if (k === "cached") mk.cached = Math.floor(n);
      else if (k === "cw") mk.cw = Math.floor(n);
    }
  }
  const d = /\[\[delay:(\d+)\]\]/.exec(src);
  if (d) mk.delay = Number(d[1]);
  const w = /\[\[words:(\d+)\]\]/.exec(src);
  if (w) mk.words = Number(w[1]);
  const r = /\[\[runaway:(\d+)\]\]/.exec(src);
  if (r) {
    mk.words = Number(r[1]);
    mk.runaway = true;
  }
  return mk;
}

const noMarkers: Markers = { notool: false, codeexec: false, thinkburn: false, nothinkdetails: false };
const stripMarkers = (s: string) => s.replace(/\[\[[^\]]*\]\]/g, "").replace(/\s+/g, " ").trim();

interface Extracted {
  /** every piece of request text (for the chars/4 prompt-token estimate) */
  texts: string[];
  lastUserText: string;
  toolName: string | null;
  toolChoiceNone: boolean;
  lastIsToolResult: boolean;
}

const emptyExtracted = (): Extracted => ({
  texts: [],
  lastUserText: "",
  toolName: null,
  toolChoiceNone: false,
  lastIsToolResult: false,
});

/** string | [{type:"text"|"input_text"|"output_text", text}|string] -> string[] */
function textParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  const out: string[] = [];
  for (const p of asArr(content)) {
    if (typeof p === "string") out.push(p);
    else if (isObj(p) && typeof p.text === "string") out.push(p.text);
  }
  return out;
}

function extractOpenAIChat(b: Obj): Extracted {
  const ex = emptyExtracted();
  const messages = asArr(b.messages);
  for (const m of messages) {
    if (!isObj(m)) continue;
    const t = textParts(m.content);
    ex.texts.push(...t);
    for (const tc of asArr(m.tool_calls)) {
      if (isObj(tc) && isObj(tc.function) && typeof tc.function.arguments === "string") ex.texts.push(tc.function.arguments);
    }
    if (m.role === "user") ex.lastUserText = t.join(" ");
  }
  const last = messages[messages.length - 1];
  ex.lastIsToolResult = isObj(last) && (last.role === "tool" || last.role === "function");
  const tools = asArr(b.tools);
  if (tools.length) {
    const t0 = tools[0];
    ex.toolName = (isObj(t0) && (isObj(t0.function) ? asStr(t0.function.name) : asStr(t0.name))) || "tool";
  }
  const tc = b.tool_choice;
  if (tc === "none") ex.toolChoiceNone = true;
  else if (isObj(tc) && isObj(tc.function) && asStr(tc.function.name)) ex.toolName = asStr(tc.function.name) ?? ex.toolName;
  return ex;
}

function extractCompletions(b: Obj): Extracted {
  const ex = emptyExtracted();
  const p = b.prompt;
  const prompts = typeof p === "string" ? [p] : asArr(p).filter((x): x is string => typeof x === "string");
  ex.texts.push(...prompts);
  ex.lastUserText = prompts[prompts.length - 1] ?? "";
  return ex;
}

function extractResponses(b: Obj): Extracted {
  const ex = emptyExtracted();
  const instructions = asStr(b.instructions);
  if (instructions) ex.texts.push(instructions);
  const input = b.input;
  if (typeof input === "string") {
    ex.texts.push(input);
    ex.lastUserText = input;
  } else {
    const items = asArr(input);
    for (const it of items) {
      if (!isObj(it)) continue;
      if (it.type === "function_call_output") {
        const out = asStr(it.output);
        if (out) ex.texts.push(out);
        continue;
      }
      if (it.type === "function_call") {
        const a = asStr(it.arguments);
        if (a) ex.texts.push(a);
        continue;
      }
      const t = textParts(it.content);
      ex.texts.push(...t);
      if (it.role === "user" || it.role === undefined) ex.lastUserText = t.join(" ");
    }
    const last = items[items.length - 1];
    ex.lastIsToolResult = isObj(last) && last.type === "function_call_output";
  }
  const fn = asArr(b.tools).find((t) => isObj(t) && t.type === "function");
  if (isObj(fn)) ex.toolName = asStr(fn.name) ?? "tool";
  else if (asArr(b.tools).length) ex.toolName = null; // only hosted tools -> never fake a function call
  if (b.tool_choice === "none") ex.toolChoiceNone = true;
  else if (isObj(b.tool_choice) && asStr(b.tool_choice.name)) ex.toolName = asStr(b.tool_choice.name) ?? ex.toolName;
  return ex;
}

function extractAnthropic(b: Obj): Extracted {
  const ex = emptyExtracted();
  ex.texts.push(...textParts(b.system));
  const messages = asArr(b.messages);
  for (const m of messages) {
    if (!isObj(m)) continue;
    const userTexts: string[] = [];
    if (typeof m.content === "string") userTexts.push(m.content);
    for (const blk of asArr(m.content)) {
      if (!isObj(blk)) continue;
      if (blk.type === "text" && typeof blk.text === "string") userTexts.push(blk.text);
      else if (blk.type === "tool_result") ex.texts.push(...textParts(blk.content));
      else if (blk.type === "tool_use" && blk.input !== undefined) ex.texts.push(JSON.stringify(blk.input));
    }
    ex.texts.push(...userTexts);
    if (m.role === "user" && userTexts.length) ex.lastUserText = userTexts.join(" ");
  }
  const last = messages[messages.length - 1];
  ex.lastIsToolResult = isObj(last) && asArr(last.content).some((x) => isObj(x) && x.type === "tool_result");
  // only user-defined (custom) tools are called; server tools (web_search_..., code_execution_...) run on the "server"
  const custom = asArr(b.tools).filter((t) => isObj(t) && (t.type === undefined || t.type === "custom"));
  if (custom.length) ex.toolName = (isObj(custom[0]) && asStr(custom[0].name)) || "tool";
  const tc = b.tool_choice;
  if (isObj(tc)) {
    if (tc.type === "none") ex.toolChoiceNone = true;
    else if (tc.type === "tool" && asStr(tc.name)) ex.toolName = asStr(tc.name) ?? ex.toolName;
  }
  return ex;
}

function extractGemini(b: Obj): Extracted {
  const ex = emptyExtracted();
  const sys = pick(b, "systemInstruction", "system_instruction");
  if (isObj(sys)) for (const p of asArr(sys.parts)) if (isObj(p) && typeof p.text === "string") ex.texts.push(p.text);
  const contents = asArr(b.contents);
  for (const c of contents) {
    if (!isObj(c)) continue;
    const t: string[] = [];
    for (const p of asArr(c.parts)) {
      if (!isObj(p)) continue;
      if (typeof p.text === "string") t.push(p.text);
      const fr = pick(p, "functionResponse", "function_response");
      if (isObj(fr)) ex.texts.push(JSON.stringify(fr.response ?? {}));
    }
    ex.texts.push(...t);
    if ((c.role === "user" || c.role === undefined) && t.length) ex.lastUserText = t.join(" ");
  }
  const last = contents[contents.length - 1];
  ex.lastIsToolResult =
    isObj(last) && asArr(last.parts).some((p) => isObj(p) && pick(p, "functionResponse", "function_response") !== undefined);
  for (const t of asArr(b.tools)) {
    if (!isObj(t)) continue;
    const decls = asArr(pick(t, "functionDeclarations", "function_declarations"));
    if (decls.length && !ex.toolName) ex.toolName = (isObj(decls[0]) && asStr(decls[0].name)) || "tool";
  }
  const cfg = pick(b, "toolConfig", "tool_config");
  const fcc = isObj(cfg) ? pick(cfg, "functionCallingConfig", "function_calling_config") : undefined;
  if (isObj(fcc)) {
    if (fcc.mode === "NONE") ex.toolChoiceNone = true;
    const allowed = asArr(pick(fcc, "allowedFunctionNames", "allowed_function_names"));
    if (fcc.mode === "ANY" && typeof allowed[0] === "string") ex.toolName = allowed[0];
  }
  return ex;
}

interface Usage {
  input: number; // total prompt tokens (inclusive of cached / cache-write)
  output: number;
  cached: number;
  cacheWrite: number;
}

function computeUsage(ex: Extracted, mk: Markers, replyWords: number, surface: Surface): Usage {
  const chars = ex.texts.reduce((a, t) => a + t.length, 0);
  const input = mk.in ?? Math.max(1, Math.ceil(chars / 4));
  const output = mk.out ?? Math.max(1, replyWords);
  const cached = Math.min(mk.cached ?? 0, input);
  const cacheWrite = surface === "anthropic" ? Math.min(mk.cw ?? 0, input - cached) : 0;
  return { input, output, cached, cacheWrite };
}

const markerSource = (ex: Extracted) => ex.lastUserText || ex.texts.join("\n");

interface Plan {
  markers: Markers;
  usage: Usage;
  /** assistant text (empty when `tool` is set) */
  text: string;
  tool: { name: string; args: string } | null;
}

/** The output cap the client asked for, in any API's spelling. */
function outputCap(b: Obj): number | undefined {
  const gc = isObj(b.generationConfig) ? b.generationConfig : isObj(b.generation_config) ? b.generation_config : {};
  return asNum(b.max_completion_tokens) ?? asNum(b.max_tokens) ?? asNum(b.max_output_tokens) ?? asNum(gc.maxOutputTokens) ?? asNum(gc.max_output_tokens);
}

function plan(ex: Extracted, surface: Surface, prefix = "Mock reply to:", cap?: number): Plan {
  const markers = parseMarkers(markerSource(ex));
  if (markers.words !== undefined) {
    const n = markers.runaway || cap === undefined ? markers.words : Math.min(markers.words, Math.max(1, Math.floor(cap)));
    const text = Array.from({ length: n }, () => "word").join(" ");
    return { markers, usage: computeUsage(ex, markers, n, surface), text, tool: null };
  }
  const useTool = !!ex.toolName && !ex.toolChoiceNone && !ex.lastIsToolResult && !markers.notool;
  if (useTool) {
    const args = JSON.stringify({ city: "Paris" });
    return { markers, usage: computeUsage(ex, markers, words(args).length, surface), text: "", tool: { name: ex.toolName as string, args } };
  }
  const text = `${prefix} ${stripMarkers(ex.lastUserText).slice(0, 80)}`.trimEnd();
  return { markers, usage: computeUsage(ex, markers, words(text).length, surface), text, tool: null };
}

function textDeltas(text: string): string[] {
  return words(text).map((w, i) => (i === 0 ? w : " " + w));
}

function resolveDelay(req: http.IncomingMessage, body: Obj | null, mk: Markers): number {
  const h = req.headers["x-mock-delay-ms"];
  const hn = typeof h === "string" ? Number(h) : NaN;
  let d = 0;
  if (Number.isFinite(hn) && hn >= 0) d = hn;
  else if (body && asNum(body.mock_delay_ms) !== undefined && (asNum(body.mock_delay_ms) as number) >= 0) d = asNum(body.mock_delay_ms) as number;
  else if (mk.delay !== undefined) d = mk.delay;
  return Math.min(d, 120_000);
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenAI: chat / completions
// ---------------------------------------------------------------------------------------------------------------------

function openaiUsage(u: Usage): Obj {
  return {
    prompt_tokens: u.input,
    completion_tokens: u.output,
    total_tokens: u.input + u.output,
    prompt_tokens_details: { cached_tokens: u.cached, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
  };
}

async function handleChat(ctx: Ctx, b: Obj): Promise<void> {
  const model = asStr(b.model);
  if (!model) return sendError(ctx, "invalid_request", "you must provide a model parameter");
  if (!Array.isArray(b.messages) || b.messages.length === 0) {
    return sendError(ctx, "invalid_request", "[] is too short - 'messages'");
  }
  const ex = extractOpenAIChat(b);
  const p = plan(ex, "openai", undefined, outputCap(b));
  const delay = resolveDelay(ctx.req, b, p.markers);
  const id = `chatcmpl-mock-${rid()}`;
  const created = nowSec();
  const finish = p.tool ? "tool_calls" : "stop";

  if (b.stream !== true) {
    if (!(await sleep(ctx, delay))) return;
    const message: Obj = { role: "assistant", content: p.tool ? null : p.text, refusal: null };
    if (p.tool) {
      message.tool_calls = [{ id: "call_mock1", type: "function", function: { name: p.tool.name, arguments: p.tool.args } }];
    }
    return sendJson(ctx, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, logprobs: null, finish_reason: finish }],
      usage: openaiUsage(p.usage),
      system_fingerprint: "fp_mock",
    });
  }

  const includeUsage = isObj(b.stream_options) && b.stream_options.include_usage === true;
  const chunk = (delta: Obj, finish_reason: string | null): string =>
    dataFrame({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      system_fingerprint: "fp_mock",
      choices: [{ index: 0, delta, logprobs: null, finish_reason }],
      ...(includeUsage ? { usage: null } : {}),
    });
  if (ctx.cred.includes("flakystart")) {
    const n = (flakyStarts.get(ctx.cred) ?? 0) + 1;
    flakyStarts.set(ctx.cred, n);
    if (n % 2 === 1) {
      // role chunk, a reasoning summary (a thinking model streams these for minutes), then the relay's failure
      return emitFrames(ctx, [chunk({ role: "assistant", content: "" }, null), chunk({ reasoning_content: "**Planning the answer**" }, null), dataFrame({ error: { message: "Service Unavailable", type: "upstream_error" } })], delay, SSE);
    }
  }
  const frames: string[] = [];
  if (p.tool) {
    frames.push(chunk({ role: "assistant", content: null }, null));
    const pieces = splitPieces(p.tool.args, 3);
    frames.push(
      chunk({ tool_calls: [{ index: 0, id: "call_mock1", type: "function", function: { name: p.tool.name, arguments: "" } }] }, null),
    );
    for (const piece of pieces) frames.push(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }, null));
  } else {
    frames.push(chunk({ role: "assistant", content: "" }, null));
    for (const d of textDeltas(p.text)) frames.push(chunk({ content: d }, null));
  }
  frames.push(chunk({}, finish));
  if (includeUsage) {
    frames.push(dataFrame({ id, object: "chat.completion.chunk", created, model, system_fingerprint: "fp_mock", choices: [], usage: openaiUsage(p.usage) }));
  }
  frames.push("data: [DONE]\n\n");
  await emitFrames(ctx, frames, delay, SSE);
}

async function handleCompletions(ctx: Ctx, b: Obj): Promise<void> {
  const model = asStr(b.model);
  if (!model) return sendError(ctx, "invalid_request", "you must provide a model parameter");
  if (b.prompt === undefined) return sendError(ctx, "invalid_request", "'prompt' is a required property");
  const ex = extractCompletions(b);
  const p = plan(ex, "openai", undefined, outputCap(b));
  const delay = resolveDelay(ctx.req, b, p.markers);
  const id = `cmpl-mock-${rid()}`;
  const created = nowSec();
  if (b.stream !== true) {
    if (!(await sleep(ctx, delay))) return;
    return sendJson(ctx, 200, {
      id,
      object: "text_completion",
      created,
      model,
      choices: [{ text: p.text, index: 0, logprobs: null, finish_reason: "stop" }],
      usage: openaiUsage(p.usage),
    });
  }
  const includeUsage = isObj(b.stream_options) && b.stream_options.include_usage === true;
  const chunk = (text: string, finish: string | null): string =>
    dataFrame({
      id,
      object: "text_completion",
      created,
      model,
      choices: [{ text, index: 0, logprobs: null, finish_reason: finish }],
      ...(includeUsage ? { usage: null } : {}),
    });
  const frames = textDeltas(p.text).map((d) => chunk(d, null));
  frames.push(chunk("", "stop"));
  if (includeUsage) frames.push(dataFrame({ id, object: "text_completion", created, model, choices: [], usage: openaiUsage(p.usage) }));
  frames.push("data: [DONE]\n\n");
  await emitFrames(ctx, frames, delay, SSE);
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenAI: responses
// ---------------------------------------------------------------------------------------------------------------------

function responsesUsage(u: Usage): Obj {
  return {
    input_tokens: u.input,
    input_tokens_details: { cached_tokens: u.cached },
    output_tokens: u.output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: u.input + u.output,
  };
}

function storeResponse(state: MockState, id: string, obj: Obj): void {
  state.responses.set(id, obj);
  if (state.responses.size > 5000) {
    const oldest = state.responses.keys().next().value;
    if (oldest !== undefined) state.responses.delete(oldest);
  }
}

async function handleResponses(ctx: Ctx, b: Obj): Promise<void> {
  const model = asStr(b.model);
  if (!model) return sendError(ctx, "invalid_request", "Missing required parameter: 'model'.");
  if (b.input === undefined) return sendError(ctx, "invalid_request", "Missing required parameter: 'input'.");
  // a relay's per-model limit: upstream models named "...rpm429..." are always over their rate limit (other models fine)
  if (model.includes("rpm429")) return sendError(ctx, "rate_limit", "Model rate limit exceeded.");
  const ex = extractResponses(b);
  const p = plan(ex, "openai", undefined, outputCap(b));
  const delay = resolveDelay(ctx.req, b, p.markers);
  const id = `resp_mock_${rid()}`;
  const msgId = `msg_mock_${rid()}`;
  const fcId = "fc_mock1";
  const createdAt = nowSec();
  const base = (status: string, output: unknown[], usage: Obj | null): Obj => ({
    id,
    object: "response",
    created_at: createdAt,
    status,
    model,
    output,
    usage,
    previous_response_id: asStr(b.previous_response_id) ?? null,
    instructions: asStr(b.instructions) ?? null,
    parallel_tool_calls: true,
    store: b.store !== false,
    tools: asArr(b.tools),
    metadata: isObj(b.metadata) ? b.metadata : {},
    error: null,
  });
  const messageItem = (status: string, text: string): Obj => ({
    type: "message",
    id: msgId,
    status,
    role: "assistant",
    content: status === "in_progress" && !text ? [] : [{ type: "output_text", text, annotations: [] }],
  });
  const callItem = (status: string, args: string): Obj => ({
    type: "function_call",
    id: fcId,
    call_id: "call_mock1",
    name: p.tool?.name ?? "",
    arguments: args,
    status,
  });
  // hosted tools that "ran": web searches, file searches, a code-interpreter run that created a file in a container
  const extra: Obj[] = [];
  for (let i = 0; i < (p.markers.ws ?? 0); i++) extra.push({ type: "web_search_call", id: `ws_mock_${i}`, status: "completed", action: { type: "search", query: "mock query" } });
  for (let i = 0; i < (p.markers.fs ?? 0); i++) extra.push({ type: "file_search_call", id: `fs_mock_${i}`, status: "completed", queries: ["mock query"], results: null });
  let citation: Obj | null = null;
  if (p.markers.codeexec) {
    const containerId = `cntr_mock${rid()}`;
    const fileId = `cfile_mock${rid()}`;
    ctx.state.containerFiles.set(`${containerId}/${fileId}`, { owner: ctx.cred, containerId, id: fileId, filename: "report.pdf", data: MOCK_PDF, createdAt: Date.now() });
    extra.push({ type: "code_interpreter_call", id: "ci_mock1", status: "completed", container_id: containerId, code: "make_pdf()", outputs: [{ type: "logs", logs: "wrote report.pdf" }] });
    citation = { type: "container_file_citation", container_id: containerId, file_id: fileId, filename: "report.pdf", start_index: 0, end_index: 0 };
  }
  const mainItem = p.tool ? callItem("completed", p.tool.args) : messageItem("completed", p.text);
  if (citation && Array.isArray(mainItem.content)) (mainItem.content as Obj[])[0].annotations = [citation];
  const finalOutput: Obj[] = [...extra, mainItem];
  const shift = extra.length;
  const finalResp = base("completed", finalOutput, responsesUsage(p.usage));
  const save = () => {
    if (b.store !== false) storeResponse(ctx.state, id, finalResp);
  };

  if (b.stream !== true) {
    if (!(await sleep(ctx, delay))) return;
    save();
    return sendJson(ctx, 200, finalResp);
  }

  let seq = 0;
  const ev = (type: string, data: Obj) => eventFrame(type, { type, sequence_number: seq++, ...data });
  const frames: string[] = [];
  if (ctx.cred.includes("ftfail") && JSON.stringify(b).includes("prompt_cache_breakpoint")) {
    frames.push(ev("response.created", { response: base("in_progress", [], null) }));
    frames.push(ev("response.in_progress", { response: base("in_progress", [], null) }));
    frames.push(ev("response.output_item.added", { output_index: 0, item: messageItem("in_progress", "") }));
    frames.push(ev("response.content_part.added", { item_id: msgId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    frames.push(ev("response.output_text.delta", { item_id: msgId, output_index: 0, content_index: 0, delta: " " }));
    frames.push(ev("response.output_text.done", { item_id: msgId, output_index: 0, content_index: 0, text: " " }));
    frames.push(ev("response.output_item.done", { output_index: 0, item: messageItem("completed", " ") }));
    const failed = { ...base("failed", [], null), error: { code: "invalid_parameter", message: "prompt_cache_breakpoint is not supported on this model", param: "prompt_cache_breakpoint" } };
    frames.push(ev("response.failed", { response: failed }));
    return emitFrames(ctx, frames, delay, SSE);
  }
  if (ctx.cred.includes("ceflaky")) {
    const n = (flakyStarts.get(ctx.cred) ?? 0) + 1;
    flakyStarts.set(ctx.cred, n);
    if (n % 2 === 1) {
      frames.push(eventFrame("response.output_text.delta", { type: "response.output_text.delta", delta: "" }));
      frames.push(ev("response.created", { response: base("in_progress", [], null) }));
      frames.push(eventFrame("codex.rate_limits", { type: "codex.rate_limits", plan_type: "mock", rate_limits: { primary: { used_percent: 1 } } }));
      frames.push(eventFrame("error", { type: "error", error: { type: "server_error", code: "server_error", message: "Our servers are currently overloaded. Please try again later." }, status: 503 }));
      return emitFrames(ctx, frames, delay, SSE);
    }
  }
  frames.push(ev("response.created", { response: base("in_progress", [], null) }));
  frames.push(ev("response.in_progress", { response: base("in_progress", [], null) }));
  extra.forEach((item, i) => {
    frames.push(ev("response.output_item.added", { output_index: i, item: { ...item, status: "in_progress" } }));
    frames.push(ev("response.output_item.done", { output_index: i, item }));
  });
  if (p.tool) {
    frames.push(ev("response.output_item.added", { output_index: shift, item: callItem("in_progress", "") }));
    for (const piece of splitPieces(p.tool.args, 3)) {
      frames.push(ev("response.function_call_arguments.delta", { item_id: fcId, output_index: shift, delta: piece }));
    }
    frames.push(ev("response.function_call_arguments.done", { item_id: fcId, output_index: shift, arguments: p.tool.args }));
    frames.push(ev("response.output_item.done", { output_index: shift, item: callItem("completed", p.tool.args) }));
  } else {
    frames.push(ev("response.output_item.added", { output_index: shift, item: messageItem("in_progress", "") }));
    frames.push(ev("response.content_part.added", { item_id: msgId, output_index: shift, content_index: 0, part: { type: "output_text", text: "", annotations: [] } }));
    for (const d of textDeltas(p.text)) {
      frames.push(ev("response.output_text.delta", { item_id: msgId, output_index: shift, content_index: 0, delta: d }));
    }
    frames.push(ev("response.output_text.done", { item_id: msgId, output_index: shift, content_index: 0, text: p.text }));
    frames.push(ev("response.content_part.done", { item_id: msgId, output_index: shift, content_index: 0, part: { type: "output_text", text: p.text, annotations: citation ? [citation] : [] } }));
    frames.push(ev("response.output_item.done", { output_index: shift, item: mainItem }));
  }
  frames.push(ev("response.completed", { response: finalResp }));
  save();
  await emitFrames(ctx, frames, delay, SSE);
}

function handleResponsesAux(ctx: Ctx, method: string, id: string, sub: string | undefined): void {
  const found = ctx.state.responses.get(id);
  const notFound = () => sendError(ctx, "not_found", `Response with id '${id}' not found.`);
  if (sub === "input_items" && method === "GET") {
    if (!found) return notFound();
    return sendJson(ctx, 200, { object: "list", data: [], first_id: null, last_id: null, has_more: false });
  }
  if (sub === "cancel" && method === "POST") {
    if (!found) return notFound();
    return sendJson(ctx, 200, { ...found, status: "cancelled" });
  }
  if (!sub && method === "GET") return found ? sendJson(ctx, 200, found) : notFound();
  if (!sub && method === "DELETE") {
    if (!found) return notFound();
    ctx.state.responses.delete(id);
    return sendJson(ctx, 200, { id, object: "response", deleted: true });
  }
  sendError(ctx, "not_found", `Unknown request URL: ${method} ${ctx.path}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// OpenAI: embeddings / images / audio / moderations / models
// ---------------------------------------------------------------------------------------------------------------------

function handleEmbeddings(ctx: Ctx, b: Obj): void {
  const model = asStr(b.model);
  if (!model) return sendError(ctx, "invalid_request", "you must provide a model parameter");
  const input = b.input;
  if (input === undefined || input === "" || (Array.isArray(input) && input.length === 0)) {
    return sendError(ctx, "invalid_request", "'input' is a required property");
  }
  let elements: string[];
  if (typeof input === "string") elements = [input];
  else if (Array.isArray(input) && input.every((x) => typeof x === "number")) elements = [input.join(" ")];
  else elements = asArr(input).map((x) => (typeof x === "string" ? x : Array.isArray(x) ? x.join(" ") : JSON.stringify(x)));
  const dims = Math.min(1536, Math.max(1, Math.floor(asNum(b.dimensions) ?? 8)));
  const mk = parseMarkers(elements.join("\n"));
  const tokens = mk.in ?? elements.reduce((a, t) => a + Math.max(1, Math.ceil(t.length / 4)), 0);
  sendJson(ctx, 200, {
    object: "list",
    data: elements.map((t, index) => ({ object: "embedding", index, embedding: embed(t, dims) })),
    model,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  });
}

function toMultipart(p: Parsed): Multipart {
  if (p.multipart) return p.multipart;
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.json ?? {})) fields[k] = typeof v === "string" ? v : JSON.stringify(v);
  return { fields, files: [] };
}

function handleImages(ctx: Ctx, p: Parsed): void {
  const mp = toMultipart(p);
  const model = mp.fields.model ?? asStr(p.json?.model) ?? "image-mock";
  const prompt = mp.fields.prompt ?? "";
  const n = Math.min(10, Math.max(1, Math.floor(Number(mp.fields.n ?? 1)) || 1));
  const mk = parseMarkers(prompt);
  const input = mk.in ?? Math.max(1, Math.ceil(prompt.length / 4));
  const output = mk.out ?? 100 * n;
  sendJson(ctx, 200, {
    created: nowSec(),
    model,
    data: Array.from({ length: n }, () => ({ b64_json: PNG_1X1 })),
    usage: {
      input_tokens: input,
      input_tokens_details: { text_tokens: input, image_tokens: 0 },
      output_tokens: output,
      total_tokens: input + output,
    },
  });
}

function handleSpeech(ctx: Ctx, b: Obj): void {
  const input = asStr(b.input);
  if (!input) return sendError(ctx, "invalid_request", "'input' is a required property");
  const size = Math.min(5_000_000, 100 + 10 * input.length);
  const buf = Buffer.alloc(size, 0x49);
  buf.write("ID3", 0, "latin1");
  const res = ctx.res;
  if (res.headersSent || res.destroyed) return;
  res.writeHead(200, { "content-type": "audio/mpeg", "content-length": size });
  res.end(buf);
}

function handleTranscription(ctx: Ctx, p: Parsed, translate: boolean): void {
  const mp = toMultipart(p);
  const bytes = mp.files.reduce((a, f) => a + f.size, 0);
  const given = Number(mp.fields.mock_duration);
  const seconds = Number.isFinite(given) && mp.fields.mock_duration !== undefined ? given : Math.max(1, Math.round(bytes / 16000));
  const fmt = mp.fields.response_format ?? "json";
  const text = translate ? "mock translation" : "mock transcription";
  if (fmt === "text" || fmt === "srt" || fmt === "vtt") {
    const res = ctx.res;
    if (res.headersSent || res.destroyed) return;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    return void res.end(text);
  }
  const body: Obj = { text, duration: seconds, usage: { type: "duration", seconds } };
  if (fmt === "verbose_json") {
    body.task = translate ? "translate" : "transcribe";
    body.language = "english";
    body.segments = [];
  }
  sendJson(ctx, 200, body);
}

function handleModeration(ctx: Ctx, b: Obj): void {
  const input = b.input;
  const count = Array.isArray(input) ? Math.max(1, input.length) : 1;
  sendJson(ctx, 200, {
    id: `modr-mock-${rid()}`,
    model: asStr(b.model) ?? "omni-moderation-latest",
    results: Array.from({ length: count }, () => ({ flagged: false, categories: {}, category_scores: {} })),
  });
}

const MOCK_MODELS = ["gpt-mock", "claude-mock", "embed-mock", "image-mock"];
function handleModels(ctx: Ctx, id?: string): void {
  const created = nowSec();
  if (id) {
    return sendJson(ctx, 200, { id, object: "model", created, owned_by: "mock" });
  }
  sendJson(ctx, 200, {
    object: "list",
    data: [
      ...MOCK_MODELS.map((m) => ({ id: m, object: "model", created, owned_by: "mock" })),
      // announced retirement, like OpenAI's `shutdown_date`
      { id: "sunset-mock", object: "model", created, owned_by: "mock", shutdown_date: "2026-12-31" },
    ],
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------------------------------------------------

function anthropicUsage(u: Usage, outputTokens = u.output): Obj {
  return {
    input_tokens: Math.max(0, u.input - u.cached - u.cacheWrite),
    cache_creation_input_tokens: u.cacheWrite,
    cache_read_input_tokens: u.cached,
    output_tokens: outputTokens,
  };
}

// ---- Claude model generations (what the real API accepts for `thinking` / sampling) -------------------------------------
interface ClaudeGen {
  family: string;
  major: number;
  minor: number;
}

function claudeGen(model: string): ClaudeGen | null {
  const m = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(model);
  return m ? { family: m[1], major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 } : null;
}

const isGen = (g: ClaudeGen, family: string, major: number, minor: number) => g.family === family && g.major === major && g.minor === minor;

/** Thinking (and sampling) validation like the real API; returns the 400 message or null. */
function anthropicParamError(model: string, b: Obj): string | null {
  const g = claudeGen(model);
  if (!g) return null;
  const th = isObj(b.thinking) ? b.thinking : null;
  const type = th ? asStr(th.type) : undefined;
  const alwaysOn = g.family === "fable" || g.family === "mythos" || isGen(g, "opus", 5, 5);
  const adaptiveOnly = alwaysOn || g.major >= 5 || (g.major === 4 && g.minor >= 7); // `enabled` + budget_tokens was removed
  const effort = isObj(b.output_config) ? asStr(b.output_config.effort) : undefined;
  if (type === "enabled") {
    if (adaptiveOnly) return '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
    const budget = th ? asNum(th.budget_tokens) : undefined;
    if (budget === undefined || budget < 1024) return "thinking.enabled.budget_tokens: Input should be greater than or equal to 1024";
    if (budget >= (asNum(b.max_tokens) ?? 0)) return "thinking.enabled.budget_tokens: Input should be less than max_tokens";
  } else if (type === "adaptive") {
    if (g.major < 4 || (g.major === 4 && g.minor < 6)) return '"thinking.type.adaptive" is not supported for this model.';
  } else if (type === "disabled") {
    if (alwaysOn || isGen(g, "sonnet", 5, 5)) {
      return '"thinking.type.disabled" is not supported for this model. Use "thinking.type.between_tools" for the lowest thinking setting, or "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.';
    }
    if ((isGen(g, "haiku", 5, 5) || isGen(g, "opus", 5, 0)) && (effort === "xhigh" || effort === "max")) {
      return `output_config.effort '${effort}' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.`;
    }
  } else if (type === "between_tools") {
    if (!isGen(g, "sonnet", 5, 5)) return '"thinking.type.between_tools" is not supported for this model.';
    if (th && Object.keys(th).some((k) => k !== "type")) return "thinking.between_tools: no other field is allowed";
    if (effort === "xhigh" || effort === "max") {
      return `output_config.effort '${effort}' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking.`;
    }
  } else if (type !== undefined) {
    return "thinking.type: Input should be 'enabled', 'disabled' or 'adaptive'";
  }
  if (effort !== undefined && !["low", "medium", "high", "xhigh", "max"].includes(effort)) return "output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'";
  if (effort === "xhigh" && g.major === 4 && g.minor < 7) return "output_config.effort 'xhigh' is not supported for this model.";
  if (effort !== undefined && (g.major < 4 || (g.major === 4 && g.minor < 5))) return "output_config.effort: not supported for this model";
  // sampling parameters were removed / narrowed on the newest models
  if (g.major >= 5 || (g.major === 4 && g.minor >= 7)) {
    const t = asNum(b.temperature);
    const tp = asNum(b.top_p);
    if (t !== undefined && t !== 1) return "temperature: non-default values are not supported for this model";
    if (tp !== undefined && tp !== 0.99) return "top_p: non-default values are not supported for this model";
    if (b.top_k !== undefined) return "top_k: not supported for this model";
  }
  return null;
}

/** Does the model think on this request? (adaptive / enabled; models that think by default do so when `thinking` is omitted) */
function thinkingActive(model: string, b: Obj): boolean {
  const g = claudeGen(model);
  const type = isObj(b.thinking) ? asStr(b.thinking.type) : undefined;
  if (type === "adaptive" || type === "enabled") return true;
  if (type === "disabled" || type === "between_tools") return false;
  if (!g) return false;
  return g.family === "fable" || g.family === "mythos" || (g.major >= 5 && g.family !== "haiku") || isGen(g, "haiku", 5, 5);
}

interface BuiltMessage {
  message: Obj;
  plan: Plan;
}

const MOCK_PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");

/** The Anthropic message object for a request (what POST /v1/messages and each batch result return), or a 400. */
function buildAnthropicMessage(ctx: Ctx, b: Obj): { error: string } | BuiltMessage {
  const model = asStr(b.model) ?? "";
  if (!model) return { error: "model: Field required" };
  if (!Array.isArray(b.messages) || b.messages.length === 0) return { error: "messages: Field required" };
  if (asNum(b.max_tokens) === undefined || (asNum(b.max_tokens) as number) < 1) return { error: "max_tokens: Field required" };
  const bad = anthropicParamError(model, b);
  if (bad) return { error: bad };
  const maxTokens = asNum(b.max_tokens) as number;
  const ex = extractAnthropic(b);
  const p = plan(ex, "anthropic", undefined, outputCap(b));
  const mk = p.markers;
  const content: Obj[] = [];
  const serverUse: Obj = { web_search_requests: 0 };
  let thinkTokens = 0;
  let burned = false;
  if (thinkingActive(model, b) && (mk.think !== undefined || mk.thinkburn)) {
    const summarized = isObj(b.thinking) && b.thinking.display === "summarized";
    burned = mk.thinkburn;
    thinkTokens = burned ? maxTokens : Math.min(mk.think ?? 0, maxTokens);
    content.push({ type: "thinking", thinking: summarized ? "I weighed the request and picked the simplest approach." : "", signature: `sig_mock_${rid()}` });
  }
  const searches = mk.ws ?? 0;
  for (let i = 0; i < searches; i++) {
    const tid = `srvtoolu_ws${i}_${rid()}`;
    content.push({ type: "server_tool_use", id: tid, name: "web_search", input: { query: "mock query" } });
    content.push({ type: "web_search_tool_result", tool_use_id: tid, content: [{ type: "web_search_result", url: `https://example.com/${i}`, title: "Example", encrypted_content: "x", page_age: null }] });
  }
  if (searches) serverUse.web_search_requests = searches;
  let container: Obj | undefined;
  if (mk.codeexec) {
    const tid = `srvtoolu_ce_${rid()}`;
    const id = mockFileId("anthropic");
    putFile(ctx, { id, owner: ctx.cred, api: "anthropic", filename: "report.pdf", purpose: "", mime: "application/pdf", bytes: MOCK_PDF.length, sha256: createHash("sha256").update(MOCK_PDF).digest("hex"), data: MOCK_PDF });
    content.push({ type: "server_tool_use", id: tid, name: "bash_code_execution", input: { command: "python make_pdf.py" } });
    content.push({
      type: "bash_code_execution_tool_result",
      tool_use_id: tid,
      content: { type: "bash_code_execution_result", stdout: "wrote report.pdf", stderr: "", return_code: 0, content: [{ type: "bash_code_execution_output", file_id: id }] },
    });
    serverUse.code_execution_requests = 1;
    container = { id: `container_mock_${rid()}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() };
  }
  const stopReason = burned ? "max_tokens" : p.tool ? "tool_use" : "end_turn";
  if (!burned) {
    if (p.tool) content.push({ type: "tool_use", id: "toolu_mock1", name: p.tool.name, input: JSON.parse(p.tool.args) as Obj });
    else content.push({ type: "text", text: p.text });
  }
  const u = { ...p.usage, output: burned ? maxTokens : p.usage.output + thinkTokens };
  const usage: Obj = { ...anthropicUsage(u), server_tool_use: serverUse, service_tier: "standard" };
  if (thinkTokens > 0 && !mk.nothinkdetails) usage.output_tokens_details = { thinking_tokens: thinkTokens };
  const message: Obj = { id: `msg_mock_${rid()}`, type: "message", role: "assistant", model, content, stop_reason: stopReason, stop_sequence: null, usage };
  if (container) message.container = container;
  return { message, plan: p };
}

async function handleAnthropicMessages(ctx: Ctx, b: Obj): Promise<void> {
  const built = buildAnthropicMessage(ctx, b);
  if ("error" in built) return sendError(ctx, "invalid_request", built.error);
  const { message, plan: p } = built;
  const delay = resolveDelay(ctx.req, b, p.markers);

  if (b.stream !== true) {
    if (!(await sleep(ctx, delay))) return;
    return sendJson(ctx, 200, message, { "request-id": `req_mock_${rid()}` });
  }

  const usage = message.usage as Obj;
  const blocks = message.content as Obj[];
  const frames: string[] = [];
  const startUsage: Obj = { ...usage, output_tokens: 1, server_tool_use: { web_search_requests: 0 } };
  delete startUsage.output_tokens_details;
  frames.push(eventFrame("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: startUsage } }));
  blocks.forEach((blk, index) => {
    const start = (cb: Obj) => frames.push(eventFrame("content_block_start", { type: "content_block_start", index, content_block: cb }));
    const delta = (d: Obj) => frames.push(eventFrame("content_block_delta", { type: "content_block_delta", index, delta: d }));
    switch (blk.type) {
      case "thinking":
        start({ type: "thinking", thinking: "", signature: "" });
        if (asStr(blk.thinking)) delta({ type: "thinking_delta", thinking: blk.thinking });
        delta({ type: "signature_delta", signature: blk.signature });
        break;
      case "tool_use":
      case "server_tool_use":
        start({ ...blk, input: {} });
        if (index === blocks.length - 1) frames.push(eventFrame("ping", { type: "ping" }));
        for (const piece of splitPieces(JSON.stringify(blk.input), 3)) delta({ type: "input_json_delta", partial_json: piece });
        break;
      case "text":
        start({ type: "text", text: "" });
        if (index === blocks.length - 1) frames.push(eventFrame("ping", { type: "ping" }));
        for (const d of textDeltas(String(blk.text))) delta({ type: "text_delta", text: d });
        break;
      default:
        start(blk); // server tool results arrive whole
    }
    frames.push(eventFrame("content_block_stop", { type: "content_block_stop", index }));
  });
  frames.push(
    eventFrame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: usage.output_tokens, server_tool_use: usage.server_tool_use, ...(usage.output_tokens_details ? { output_tokens_details: usage.output_tokens_details } : {}) },
    }),
  );
  frames.push(eventFrame("message_stop", { type: "message_stop" }));
  await emitFrames(ctx, frames, delay, SSE);
}

function handleAnthropicCountTokens(ctx: Ctx, b: Obj): void {
  if (!asStr(b.model)) return sendError(ctx, "invalid_request", "model: Field required");
  if (!Array.isArray(b.messages) || b.messages.length === 0) return sendError(ctx, "invalid_request", "messages: Field required");
  const ex = extractAnthropic(b);
  const mk = parseMarkers(markerSource(ex));
  const chars = ex.texts.reduce((a, t) => a + t.length, 0);
  sendJson(ctx, 200, { input_tokens: mk.in ?? Math.max(1, Math.ceil(chars / 4)) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------------------------------------------------

function geminiUsage(u: Usage): Obj {
  const m: Obj = { promptTokenCount: u.input, candidatesTokenCount: u.output, totalTokenCount: u.input + u.output };
  if (u.cached > 0) m.cachedContentTokenCount = u.cached;
  return m;
}

async function handleGemini(ctx: Ctx, model: string, method: string, b: Obj): Promise<void> {
  if (method === "countTokens") {
    const inner = pick(b, "generateContentRequest", "generate_content_request");
    const ex = extractGemini(isObj(inner) ? inner : b);
    const mk = parseMarkers(markerSource(ex));
    const chars = ex.texts.reduce((a, t) => a + t.length, 0);
    return sendJson(ctx, 200, { totalTokens: mk.in ?? Math.max(1, Math.ceil(chars / 4)) });
  }
  if (method === "embedContent" || method === "batchEmbedContents") {
    const textOf = (req: unknown): string => {
      if (!isObj(req) || !isObj(req.content)) return "";
      return asArr(req.content.parts)
        .map((x) => (isObj(x) && typeof x.text === "string" ? x.text : ""))
        .join(" ");
    };
    const dimsOf = (req: unknown): number => {
      const d = isObj(req) ? asNum(pick(req, "outputDimensionality", "output_dimensionality")) : undefined;
      return Math.min(1536, Math.max(1, Math.floor(d ?? 8)));
    };
    if (method === "embedContent") {
      return sendJson(ctx, 200, { embedding: { values: embed(textOf(b), dimsOf(b)) } });
    }
    const reqs = asArr(b.requests);
    if (reqs.length === 0) return sendError(ctx, "invalid_request", "requests: at least one request is required");
    return sendJson(ctx, 200, { embeddings: reqs.map((r) => ({ values: embed(textOf(r), dimsOf(r)) })) });
  }

  // generateContent / streamGenerateContent
  if (asArr(b.contents).length === 0) return sendError(ctx, "invalid_request", "contents is not specified");
  const ex = extractGemini(b);
  const p = plan(ex, "gemini", undefined, outputCap(b));
  const delay = resolveDelay(ctx.req, b, p.markers);
  const responseId = `mockresp${rid()}`;
  const part: Obj = p.tool ? { functionCall: { name: p.tool.name, args: JSON.parse(p.tool.args) as Obj } } : { text: p.text };

  if (method === "generateContent") {
    if (!(await sleep(ctx, delay))) return;
    return sendJson(ctx, 200, {
      candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }],
      usageMetadata: geminiUsage(p.usage),
      modelVersion: model,
      responseId,
    });
  }

  // streamGenerateContent
  const chunks: Obj[] = [];
  if (p.tool) {
    chunks.push({
      candidates: [{ content: { role: "model", parts: [part] }, finishReason: "STOP", index: 0 }],
      usageMetadata: geminiUsage(p.usage),
      modelVersion: model,
      responseId,
    });
  } else {
    const deltas = textDeltas(p.text);
    deltas.forEach((d, i) => {
      const last = i === deltas.length - 1;
      chunks.push({
        candidates: [{ content: { role: "model", parts: [{ text: d }] }, ...(last ? { finishReason: "STOP" } : {}), index: 0 }],
        ...(last ? { usageMetadata: geminiUsage(p.usage) } : {}),
        modelVersion: model,
        responseId,
      });
    });
  }
  if (ctx.url.searchParams.get("alt") === "sse") {
    await emitFrames(ctx, chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`), delay, SSE);
  } else {
    // no alt=sse: Gemini streams a JSON array, element by element
    const frames = chunks.map((c, i) => (i === 0 ? "[\n" : ",\n") + JSON.stringify(c));
    frames.push("\n]");
    await emitFrames(ctx, frames, delay, "application/json");
  }
}

function handleGeminiModels(ctx: Ctx, model?: string): void {
  const entry = (m: string): Obj => ({
    name: `models/${m}`,
    version: "001",
    displayName: m,
    inputTokenLimit: 1_000_000,
    outputTokenLimit: 8192,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens", "embedContent"],
  });
  if (model) return sendJson(ctx, 200, entry(model));
  sendJson(ctx, 200, { models: MOCK_MODELS.map(entry) });
}

// ---------------------------------------------------------------------------------------------------------------------
// fal.ai / Replicate / OpenAI-style videos (for the live-provider adapters)
//
//   fal sync   : POST /fal/<model>                       (Authorization: Key <k>)   -> { images: [{ url }] }
//   fal queue  : POST /fal-queue/<model>                 -> { request_id, status_url, response_url }
//                GET  /fal-queue/<app>/requests/<id>/status -> IN_QUEUE, IN_PROGRESS, COMPLETED
//                GET  /fal-queue/<app>/requests/<id>        -> result
//   Replicate  : POST /replicate/v1/models/<owner>/<name>/predictions  (Authorization: Bearer <t>, Prefer: wait)
//                POST /replicate/v1/predictions {version,input} ; GET /replicate/v1/predictions/<id> ; GET .../account
//   videos     : POST /v1/videos, GET /v1/videos[/<id>[/content]], DELETE /v1/videos/<id>   (Bearer)
//   images     : GET /__mock/img/<n>.png  (no auth; what the fal/Replicate result URLs point to)
// Prompt markers: [[sync504]] fal sync answers 504 (adapter falls back to the queue) · [[slowpred]] Replicate does not
// finish within Prefer: wait · [[predfail]] / [[prednsfw]] Replicate failure · [[vidfail]] video ends failed ·
// [[delay:N]] sleeps N ms · [[fal422]] / [[pred422]] validation errors. Fault keys work as everywhere else.
// ---------------------------------------------------------------------------------------------------------------------

interface MockVideo {
  id: string;
  model: string;
  prompt: string;
  seconds: string;
  size: string;
  polls: number;
  fail: boolean;
  redirect: boolean;
  createdAt: number;
  deleted: boolean;
}
interface MockQueueJob {
  id: string;
  app: string;
  model: string;
  input: Obj;
  polls: number;
}
interface MockPrediction {
  id: string;
  model: string;
  version: string | null;
  input: Obj;
  polls: number;
  mode: "ok" | "fail" | "nsfw";
}
interface MockExtras {
  videos: Map<string, MockVideo>;
  falJobs: Map<string, MockQueueJob>;
  predictions: Map<string, MockPrediction>;
}

const MOCK_PNG = Buffer.from(PNG_1X1, "base64");
const MOCK_MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(4096, 0x61)]);

const originOf = (ctx: Ctx) => `http://${ctx.req.headers.host ?? "127.0.0.1"}`;

function extraMarkers(src: string) {
  return {
    delay: Number(/\[\[delay:(\d+)\]\]/.exec(src)?.[1] ?? 0),
    sync504: /\[\[sync504\]\]/.test(src),
    slowpred: /\[\[slowpred\]\]/.test(src),
    predfail: /\[\[predfail\]\]/.test(src),
    prednsfw: /\[\[prednsfw\]\]/.test(src),
    vidfail: /\[\[vidfail\]\]/.test(src),
    vidredirect: /\[\[vidredirect\]\]/.test(src),
    fal422: /\[\[fal422\]\]/.test(src),
    pred422: /\[\[pred422\]\]/.test(src),
  };
}

type ExtraKind = "fal" | "fal-queue" | "replicate" | "videos" | "img";

function extraKindOf(path: string): ExtraKind | null {
  if (path.startsWith("/fal-queue/")) return "fal-queue";
  if (path.startsWith("/fal/")) return "fal";
  if (path.startsWith("/replicate/")) return "replicate";
  if (path === "/v1/videos" || path.startsWith("/v1/videos/")) return "videos";
  if (path.startsWith("/__mock/img/") || path.startsWith("/__mock/media/")) return "img";
  return null;
}

/** Errors in each vendor's own shape. */
function extraError(ctx: Ctx, kind: ExtraKind, status: number, message: string, headers: Record<string, string> = {}): void {
  if (kind === "videos") {
    const map: Record<number, ErrKind> = { 400: "invalid_request", 401: "auth", 404: "not_found", 429: "rate_limit", 500: "server" };
    return sendError(ctx, map[status] ?? "server", message, headers);
  }
  if (kind === "replicate") {
    const title = status === 401 ? "Unauthenticated" : status === 404 ? "The specified resource does not exist" : status === 422 ? "Invalid version or not permitted" : status === 429 ? "Request was throttled" : "Error";
    return sendJson(ctx, status, { title, detail: message, status }, headers);
  }
  // fal: { detail: "..." } or { detail: [{ loc, msg, type }] } for validation
  if (status === 422) return sendJson(ctx, 422, { detail: [{ loc: ["body", "prompt"], msg: message, type: "value_error" }] }, headers);
  sendJson(ctx, status, { detail: message }, headers);
}

/** Send bytes with Range support (206 + content-range), like a CDN would. */
function sendBytes(ctx: Ctx, data: Buffer, type: string): void {
  const res = ctx.res;
  if (res.headersSent || res.destroyed) return;
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(ctx.req.headers.range ?? ""));
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, data.length - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    res.writeHead(206, { "content-type": type, "content-length": end - start + 1, "content-range": `bytes ${start}-${end}/${data.length}`, "accept-ranges": "bytes" });
    return void res.end(data.subarray(start, end + 1));
  }
  res.writeHead(200, { "content-type": type, "content-length": data.length, "accept-ranges": "bytes" });
  res.end(data);
}

function falImageResult(ctx: Ctx, input: Obj): Obj {
  const n = Math.min(4, Math.max(1, Math.floor(Number(input.num_images ?? 1)) || 1));
  const size = isObj(input.image_size) ? input.image_size : null;
  return {
    images: Array.from({ length: n }, (_, i) => ({
      url: `${originOf(ctx)}/__mock/img/${rid()}-${i}.png`,
      width: Number(size?.width ?? 1024),
      height: Number(size?.height ?? 1024),
      content_type: "image/png",
    })),
    timings: { inference: 0.4 },
    seed: Number(input.seed ?? 42),
    has_nsfw_concepts: Array.from({ length: n }, () => false),
    prompt: String(input.prompt ?? ""),
  };
}

async function handleExtra(ctx: Ctx, kind: ExtraKind, raw: Buffer): Promise<void> {
  const { req, path } = ctx;
  const method = (req.method ?? "GET").toUpperCase();
  const ex = (ctx.state.extras ??= { videos: new Map(), falJobs: new Map(), predictions: new Map() });

  // unauthenticated static bytes (what result URLs / CDN redirects point to)
  if (kind === "img") {
    const res = ctx.res;
    if (res.headersSent || res.destroyed) return;
    if (path.startsWith("/__mock/media/")) return sendBytes(ctx, MOCK_MP4, "video/mp4");
    res.writeHead(200, { "content-type": "image/png", "content-length": MOCK_PNG.length });
    return void res.end(MOCK_PNG);
  }

  // ---- auth: fal = "Key", Replicate/videos = "Bearer"
  const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const m = /^(Key|Bearer)\s+(.+)$/i.exec(auth);
  const wantScheme = kind === "fal" || kind === "fal-queue" ? "key" : "bearer";
  if (!m) return extraError(ctx, kind, 401, kind === "videos" ? authMessage("openai") : "missing credentials");
  const cred = m[2].trim();
  if (m[1].toLowerCase() !== wantScheme) return extraError(ctx, kind, 401, `wrong auth scheme '${m[1]}' (expected ${wantScheme})`);
  if (cred.includes("slow") && !(await sleep(ctx, 1500))) return;
  if (cred.includes("bad")) return extraError(ctx, kind, 401, kind === "fal" || kind === "fal-queue" ? "invalid key credentials" : "Incorrect API key provided.");
  if (cred.includes("fail429")) return extraError(ctx, kind, 429, "Rate limit exceeded (mock fail429 key).", { "retry-after": "2" });
  if (cred.includes("fail500")) return extraError(ctx, kind, 500, "Internal server error (mock fail500 key).");

  let body: Obj = {};
  let multipart: Multipart | null = null;
  if (method === "POST") {
    try {
      const parsed = parseBody(raw, String(req.headers["content-type"] ?? ""));
      body = parsed.json ?? {};
      multipart = parsed.multipart;
    } catch (e) {
      return extraError(ctx, kind, 400, e instanceof BadBody ? e.message : "Invalid request body");
    }
  }

  // ---------------------------------------------------------------- fal sync
  if (kind === "fal") {
    if (method === "GET" && path === "/fal/__ping") return sendJson(ctx, 200, { ok: true });
    if (method !== "POST") return extraError(ctx, kind, 405, "Method not allowed");
    const model = path.slice("/fal/".length);
    const prompt = String(body.prompt ?? "");
    const mk = extraMarkers(prompt);
    if (!prompt) return extraError(ctx, kind, 422, "field required");
    if (mk.fal422) return extraError(ctx, kind, 422, "image_size is not valid for this model");
    if (mk.delay && !(await sleep(ctx, mk.delay))) return;
    if (mk.sync504) return extraError(ctx, kind, 504, "Gateway timeout");
    void model;
    return sendJson(ctx, 200, falImageResult(ctx, body));
  }

  // ---------------------------------------------------------------- fal queue
  if (kind === "fal-queue") {
    const jobRe = /^\/fal-queue\/(.+?)\/requests\/([^/]+)(?:\/(status|cancel))?$/.exec(path);
    if (jobRe) {
      const job = ex.falJobs.get(jobRe[2]);
      if (!job) return sendJson(ctx, 404, jobRe[3] === "status" ? { status: "NOT_FOUND" } : { detail: "Request not found" });
      if (jobRe[3] === "cancel") return sendJson(ctx, 200, { status: "CANCELLATION_REQUESTED" });
      if (jobRe[3] === "status") {
        job.polls++;
        const status = job.polls <= 1 ? "IN_QUEUE" : job.polls === 2 ? "IN_PROGRESS" : "COMPLETED";
        return sendJson(ctx, 200, { status, request_id: job.id, ...(status === "IN_QUEUE" ? { queue_position: 0 } : {}) });
      }
      if (job.polls < 3) return sendJson(ctx, 400, { detail: "Request is still in progress" });
      if (/video|kling|veo|wan/.test(job.model)) {
        if (extraMarkers(String(job.input.prompt ?? "")).vidfail) return sendJson(ctx, 422, { detail: [{ loc: ["body", "prompt"], msg: "Content policy violation", type: "content_policy_violation" }] });
        return sendJson(ctx, 200, { video: { url: `${originOf(ctx)}/__mock/media/fal-${job.id}.mp4`, content_type: "video/mp4", file_name: "out.mp4" }, seed: 1 });
      }
      return sendJson(ctx, 200, falImageResult(ctx, job.input));
    }
    if (method !== "POST") return extraError(ctx, "fal", 405, "Method not allowed");
    const model = path.slice("/fal-queue/".length);
    if (!String(body.prompt ?? "")) return extraError(ctx, "fal", 422, "field required");
    const id = randomUUID();
    const app = model.split("/").slice(0, 2).join("/");
    ex.falJobs.set(id, { id, app, model, input: body, polls: 0 });
    const o = originOf(ctx);
    return sendJson(ctx, 200, {
      request_id: id,
      response_url: `${o}/fal-queue/${app}/requests/${id}`,
      status_url: `${o}/fal-queue/${app}/requests/${id}/status`,
      cancel_url: `${o}/fal-queue/${app}/requests/${id}/cancel`,
    });
  }

  // ---------------------------------------------------------------- Replicate
  if (kind === "replicate") {
    const base = "/replicate/v1";
    const predObj = (p: MockPrediction, status: "starting" | "processing" | "succeeded" | "failed"): Obj => {
      const o = originOf(ctx);
      const n = Math.min(4, Math.max(1, Math.floor(Number(p.input.num_outputs ?? 1)) || 1));
      return {
        id: p.id,
        model: p.model,
        version: p.version ?? "mockversion",
        input: p.input,
        logs: "",
        output: status === "succeeded" ? Array.from({ length: n }, (_, i) => `${o}/__mock/img/${p.id}-${i}.png`) : null,
        data_removed: false,
        error: status === "failed" ? (p.mode === "nsfw" ? "NSFW content detected. Try a different prompt." : "CUDA out of memory (mock)") : null,
        status,
        created_at: new Date().toISOString(),
        urls: { get: `${o}${base}/predictions/${p.id}`, cancel: `${o}${base}/predictions/${p.id}/cancel`, stream: `${o}${base}/predictions/${p.id}/stream` },
        metrics: status === "succeeded" ? { predict_time: 0.5 } : {},
      };
    };
    if (method === "GET" && path === `${base}/account`) return sendJson(ctx, 200, { type: "organization", username: "mock", name: null, avatar_url: null, github_url: null });
    const predRe = /^\/replicate\/v1\/predictions\/([^/]+)(?:\/(cancel))?$/.exec(path);
    if (predRe) {
      const p = ex.predictions.get(predRe[1]);
      if (!p) return extraError(ctx, kind, 404, "The requested resource could not be found.");
      if (predRe[2] === "cancel") return sendJson(ctx, 200, predObj(p, "failed"));
      p.polls++;
      if (p.mode !== "ok") return sendJson(ctx, 200, predObj(p, "failed"));
      return sendJson(ctx, 200, predObj(p, p.polls >= 2 ? "succeeded" : "processing"));
    }
    const modelRe = /^\/replicate\/v1\/models\/([^/]+)\/([^/]+)\/predictions$/.exec(path);
    if (method === "POST" && (modelRe || path === `${base}/predictions`)) {
      const input = isObj(body.input) ? body.input : null;
      if (!input) return extraError(ctx, kind, 422, "input: Field required");
      const prompt = String(input.prompt ?? "");
      const mk = extraMarkers(prompt);
      if (mk.pred422) return extraError(ctx, kind, 422, "aspect_ratio must be one of the allowed values");
      if (mk.delay && !(await sleep(ctx, mk.delay))) return;
      const model = modelRe ? `${modelRe[1]}/${modelRe[2]}` : "pinned/version";
      const version = path === `${base}/predictions` ? String(body.version ?? "") : null;
      if (path === `${base}/predictions` && !version) return extraError(ctx, kind, 422, "version: Field required");
      const p: MockPrediction = { id: rid(), model, version, input, polls: 0, mode: mk.prednsfw ? "nsfw" : mk.predfail ? "fail" : "ok" };
      ex.predictions.set(p.id, p);
      const wait = /wait/i.test(String(req.headers.prefer ?? ""));
      if (wait && !mk.slowpred) {
        if (p.mode !== "ok") return sendJson(ctx, 201, predObj(p, "failed"));
        return sendJson(ctx, 201, predObj(p, "succeeded"));
      }
      return sendJson(ctx, 201, predObj(p, "starting"));
    }
    return extraError(ctx, kind, 404, `Unknown request URL: ${method} ${path}`);
  }

  // ---------------------------------------------------------------- videos (OpenAI Sora shape)
  const vidObj = (v: MockVideo): Obj => {
    const done = v.polls >= 2;
    const failed = done && v.fail;
    const status = failed ? "failed" : done ? "completed" : v.polls === 1 ? "in_progress" : "queued";
    return {
      id: v.id,
      object: "video",
      model: v.model,
      status,
      progress: done ? (failed ? 0 : 100) : v.polls === 1 ? 50 : 0,
      created_at: Math.floor(v.createdAt / 1000),
      completed_at: done && !failed ? nowSec() : null,
      expires_at: done && !failed ? nowSec() + 3600 : null,
      error: failed ? { code: "moderation_blocked", message: "Your request was blocked by our moderation system." } : null,
      remixed_from_video_id: null,
      seconds: v.seconds,
      size: v.size,
    };
  };
  if (path === "/v1/videos") {
    if (method === "GET") {
      const data = [...ex.videos.values()].filter((v) => !v.deleted).map(vidObj);
      return sendJson(ctx, 200, { object: "list", data, first_id: data[0]?.id ?? null, last_id: data[data.length - 1]?.id ?? null, has_more: false });
    }
    const fields: Record<string, unknown> = multipart ? { ...multipart.fields } : body;
    const model = asStr(fields.model);
    const prompt = asStr(fields.prompt);
    if (!model) return sendError(ctx, "invalid_request", "Missing required parameter: 'model'.");
    if (!prompt) return sendError(ctx, "invalid_request", "Missing required parameter: 'prompt'.");
    const seconds = fields.seconds === undefined ? "4" : String(fields.seconds);
    if (!["4", "8", "12"].includes(seconds)) return sendError(ctx, "invalid_request", "Invalid value for 'seconds': must be one of 4, 8, 12.");
    const mk = extraMarkers(prompt);
    if (mk.delay && !(await sleep(ctx, mk.delay))) return;
    const v: MockVideo = {
      id: `video_mock_${rid()}`,
      model,
      prompt,
      seconds,
      size: asStr(fields.size) ?? "720x1280",
      polls: 0,
      fail: mk.vidfail,
      redirect: mk.vidredirect,
      createdAt: Date.now(),
      deleted: false,
    };
    ex.videos.set(v.id, v);
    return sendJson(ctx, 200, vidObj(v));
  }
  const vm = /^\/v1\/videos\/([^/]+)(?:\/(content))?$/.exec(path);
  const v = vm ? ex.videos.get(decodeURIComponent(vm[1])) : undefined;
  if (!vm || !v || v.deleted) return sendError(ctx, "not_found", `Video with id '${vm?.[1] ?? ""}' not found.`);
  if (method === "DELETE") {
    v.deleted = true;
    return sendJson(ctx, 200, { id: v.id, object: "video.deleted", deleted: true });
  }
  if (vm[2] === "content") {
    if (v.polls < 2 || v.fail) return sendError(ctx, "not_found", "The video content is not available.");
    if (v.redirect && !ctx.url.searchParams.get("variant")) {
      ctx.res.writeHead(302, { location: `${originOf(ctx)}/__mock/media/${v.id}.mp4` });
      return void ctx.res.end();
    }
    const variant = ctx.url.searchParams.get("variant") ?? "video";
    const isVideo = variant === "video";
    const data = isVideo ? MOCK_MP4 : MOCK_PNG;
    const type = isVideo ? "video/mp4" : variant === "thumbnail" ? "image/webp" : "image/jpeg";
    return sendBytes(ctx, data, type);
  }
  v.polls++;
  return sendJson(ctx, 200, vidObj(v));
}

// ---------------------------------------------------------------------------------------------------------------------
// Files APIs (OpenAI /v1/files + /v1/uploads, Anthropic /v1/files, Gemini resumable upload + /v1beta/files)
// A file belongs to the upstream credential that created it: any other key answers 404, exactly like separate accounts.
// ---------------------------------------------------------------------------------------------------------------------

const FILE_KEEP_BYTES = 16 * 1024 * 1024;

function isFilesPath(path: string): boolean {
  return (
    path === "/v1/files" ||
    path.startsWith("/v1/files/") ||
    path === "/v1/uploads" ||
    path.startsWith("/v1/uploads/") ||
    path.startsWith("/v1/containers/") ||
    path === "/v1beta/files" ||
    path.startsWith("/v1beta/files/") ||
    path === "/upload/v1beta/files"
  );
}

/** Deterministic filler for downloads of files whose bytes were not kept. */
function patternChunk(offset: number, len: number): Buffer {
  const b = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) b[i] = (offset + i) & 0xff;
  return b;
}

/** Stream `total` bytes (a Buffer or generated pattern) with per-chunk delay so a client abort can be observed mid-download. */
async function streamBytes(ctx: Ctx, total: number, source: Buffer | null, type: string, headers: Record<string, string> = {}): Promise<void> {
  const res = ctx.res;
  if (res.headersSent || res.destroyed) return;
  const delay = resolveDelay(ctx.req, null, noMarkers);
  if (ctx.fault?.dropHeaders) return cutConnection(ctx, "rst");
  res.writeHead(200, { "content-type": type, "content-length": total, ...idHeaders(), ...headers });
  ctx.phase = "streaming";
  const CHUNK = 64 * 1024;
  let sent = 0;
  while (sent < total) {
    if (!(await sleep(ctx, delay))) return;
    if (res.destroyed) return;
    const n = Math.min(CHUNK, total - sent);
    await writeFlushed(ctx, res, source ? source.subarray(sent, sent + n) : patternChunk(sent, n));
    sent += n;
    ctx.frames++;
    if (ctx.fault?.rstAfter !== undefined && ctx.frames >= ctx.fault.rstAfter) return cutConnection(ctx, "rst");
  }
  res.end();
}

const mockFileId = (api: MockFile["api"]) => (api === "openai" ? `file-mock${rid()}` : api === "anthropic" ? `file_011mock${rid()}` : `mock${rid().toLowerCase()}`);

function fileObject(f: Omit<MockFile, "object">, origin: string): Obj {
  switch (f.api) {
    case "anthropic":
      return { id: f.id, type: "file", filename: f.filename, mime_type: f.mime, size_bytes: f.bytes, created_at: new Date(f.createdAt).toISOString(), downloadable: false };
    case "gemini":
      return {
        name: `files/${f.id}`,
        displayName: f.filename,
        mimeType: f.mime,
        sizeBytes: String(f.bytes),
        createTime: new Date(f.createdAt).toISOString(),
        updateTime: new Date(f.createdAt).toISOString(),
        expirationTime: new Date(f.createdAt + 172_800_000).toISOString(),
        sha256Hash: Buffer.from(f.sha256, "hex").toString("base64"),
        uri: `${origin}/v1beta/files/${f.id}`,
        state: "ACTIVE",
        source: "UPLOADED",
      };
    default:
      return { id: f.id, object: "file", bytes: f.bytes, created_at: Math.floor(f.createdAt / 1000), filename: f.filename, purpose: f.purpose, status: "processed", status_details: null };
  }
}

function putFile(ctx: Ctx, f: Omit<MockFile, "object" | "createdAt">): MockFile {
  const full = { ...f, createdAt: Date.now() };
  const file: MockFile = { ...full, object: fileObject(full, originOf(ctx)) };
  ctx.state.files.set(`${f.api}:${f.id}`, file);
  return file;
}

function ownFile(ctx: Ctx, api: MockFile["api"], id: string): MockFile | null {
  const f = ctx.state.files.get(`${api}:${id}`);
  return f && f.owner === ctx.cred ? f : null;
}

function fileNotFound(ctx: Ctx, id: string): void {
  if (ctx.surface === "anthropic") return sendJson(ctx, 404, { type: "error", error: { type: "not_found_error", message: `File not found: ${id}` }, request_id: `req_mock_${rid()}` });
  if (ctx.surface === "gemini") return sendJson(ctx, 403, { error: { code: 403, message: `Permission denied on resource or it may not exist: files/${id}`, status: "PERMISSION_DENIED" } });
  sendJson(ctx, 404, { error: { message: `No such File object: ${id}`, type: "invalid_request_error", param: "id", code: null } });
}

/** The first file part of a multipart body kept in memory, with its metadata. */
function firstFilePart(raw: Buffer, contentType: string): { filename: string; mime: string; data: Buffer; fields: Record<string, string> } | null {
  const boundary = boundaryOf(contentType);
  if (!boundary || raw.length === 0) return null;
  const sc = new MultipartScanner(boundary);
  try {
    sc.push(raw);
  } catch {
    return null;
  }
  const f = sc.files[0];
  if (!f) return null;
  return { filename: f.filename, mime: f.type || "application/octet-stream", data: raw.subarray(f.start, f.end), fields: Object.fromEntries(sc.fields.map((x) => [x.name, x.value])) };
}

async function handleFilesApi(ctx: Ctx, raw: Buffer): Promise<void> {
  const { req, path, url, state } = ctx;
  const method = (req.method ?? "GET").toUpperCase();
  const ct = String(req.headers["content-type"] ?? "");
  const origin = originOf(ctx);
  const jsonBody = (): Obj => {
    try {
      const v: unknown = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      return isObj(v) ? v : {};
    } catch {
      return {};
    }
  };

  // ------------------------------------------------------------------ OpenAI + Anthropic /v1/files
  if (path === "/v1/files" || path.startsWith("/v1/files/")) {
    const api: MockFile["api"] = ctx.surface === "anthropic" ? "anthropic" : "openai";
    if (api === "anthropic" && !String(req.headers["anthropic-beta"] ?? "").includes("files-api")) {
      return sendError(ctx, "invalid_request", "The Files API is in beta: send the anthropic-beta: files-api-2025-04-14 header.");
    }
    const m = /^\/v1\/files\/([^/]+)(\/content)?$/.exec(path);
    if (path === "/v1/files" && method === "POST") {
      // small bodies are kept, big ones were hashed on the fly
      let filename = "file";
      let mime = "application/octet-stream";
      let purpose = "assistants";
      let bytes = 0;
      let data: Buffer | null = null;
      let sha = ctx.hashed?.sha256 ?? "";
      if (ctx.hashed) {
        const f = ctx.scan?.files[0];
        if (!f) return sendError(ctx, "invalid_request", "Missing required parameter: 'file'.");
        filename = f.filename;
        mime = f.type || mime;
        bytes = f.size;
        purpose = ctx.scan?.fields.find((x) => x.name === "purpose")?.value ?? purpose;
      } else {
        const part = firstFilePart(raw, ct);
        if (!part) return sendError(ctx, "invalid_request", "Missing required parameter: 'file'.");
        filename = part.filename;
        mime = part.mime;
        bytes = part.data.length;
        purpose = part.fields.purpose ?? purpose;
        sha = createHash("sha256").update(part.data).digest("hex");
        if (bytes <= FILE_KEEP_BYTES) data = Buffer.from(part.data);
      }
      if (api === "openai" && !purpose) return sendError(ctx, "invalid_request", "Missing required parameter: 'purpose'.");
      const f = putFile(ctx, { id: mockFileId(api), owner: ctx.cred, api, filename, purpose, mime, bytes, sha256: sha, data });
      return sendJson(ctx, 200, f.object, idHeaders());
    }
    if (path === "/v1/files" && method === "GET") {
      const mine = [...state.files.values()].filter((f) => f.api === api && f.owner === ctx.cred).sort((a, b) => b.createdAt - a.createdAt);
      const data = mine.map((f) => f.object);
      if (api === "anthropic") return sendJson(ctx, 200, { data, has_more: false, first_id: mine[0]?.id ?? null, last_id: mine[mine.length - 1]?.id ?? null });
      return sendJson(ctx, 200, { object: "list", data, has_more: false });
    }
    if (m) {
      const id = decodeURIComponent(m[1]);
      const f = ownFile(ctx, api, id);
      if (!f) return fileNotFound(ctx, id);
      if (m[2] && method === "GET") return streamBytes(ctx, f.bytes, f.data, f.mime);
      if (!m[2] && method === "GET") return sendJson(ctx, 200, f.object, idHeaders());
      if (!m[2] && method === "DELETE") {
        state.files.delete(`${api}:${id}`);
        return sendJson(ctx, 200, api === "anthropic" ? { id, type: "file_deleted" } : { id, object: "file", deleted: true });
      }
    }
    return sendError(ctx, "not_found", `Unknown request URL: ${method} ${path}`);
  }

  // ------------------------------------------------------------------ OpenAI code-interpreter container files
  const cm = /^\/v1\/containers\/([^/]+)\/files\/([^/]+)(\/content)?$/.exec(path);
  if (cm && method === "GET") {
    const [, cid, fid] = cm.map((x) => (x ? decodeURIComponent(x) : x));
    const f = state.containerFiles.get(`${cid}/${fid}`);
    if (!f || f.owner !== ctx.cred) return sendJson(ctx, 404, { error: { message: `File with id '${fid}' not found in container '${cid}'.`, type: "invalid_request_error", param: null, code: null } });
    if (cm[3]) return streamBytes(ctx, f.data.length, f.data, "application/pdf");
    return sendJson(ctx, 200, { id: f.id, object: "container.file", container_id: f.containerId, created_at: Math.floor(f.createdAt / 1000), bytes: f.data.length, path: `/mnt/data/${f.filename}`, source: "assistant" }, idHeaders());
  }

  // ------------------------------------------------------------------ OpenAI /v1/uploads
  if (path === "/v1/uploads" || path.startsWith("/v1/uploads/")) {
    const uploadObj = (u: MockUpload, file: Obj | null): Obj => ({
      id: u.id,
      object: "upload",
      bytes: u.bytes,
      created_at: nowSec(),
      filename: u.filename,
      purpose: u.purpose,
      status: u.status,
      expires_at: nowSec() + 3600,
      file,
    });
    if (path === "/v1/uploads" && method === "POST") {
      const b = jsonBody();
      const filename = asStr(b.filename);
      const purpose = asStr(b.purpose);
      const bytes = asNum(b.bytes);
      if (!filename || !purpose || bytes === undefined) return sendError(ctx, "invalid_request", "filename, purpose and bytes are required.");
      const u: MockUpload = { id: `upload_mock${rid()}`, owner: ctx.cred, filename, purpose, mime: asStr(b.mime_type) ?? "application/octet-stream", bytes, parts: new Map(), status: "pending" };
      state.uploads.set(u.id, u);
      return sendJson(ctx, 200, uploadObj(u, null), idHeaders());
    }
    const m = /^\/v1\/uploads\/([^/]+)\/(parts|complete|cancel)$/.exec(path);
    if (m && method === "POST") {
      const id = decodeURIComponent(m[1]);
      const u = state.uploads.get(id);
      if (!u || u.owner !== ctx.cred) return sendJson(ctx, 404, { error: { message: `No such Upload object: ${id}`, type: "invalid_request_error", param: "id", code: null } });
      if (m[2] === "parts") {
        const size = ctx.hashed ? (ctx.scan?.files[0]?.size ?? ctx.hashed.bytes) : (firstFilePart(raw, ct)?.data.length ?? 0);
        const sha = ctx.hashed?.sha256 ?? createHash("sha256").update(raw).digest("hex");
        const partId = `part_mock${rid()}`;
        u.parts.set(partId, { size, sha256: sha });
        return sendJson(ctx, 200, { id: partId, object: "upload.part", created_at: nowSec(), upload_id: id }, idHeaders());
      }
      if (m[2] === "cancel") {
        u.status = "cancelled";
        return sendJson(ctx, 200, uploadObj(u, null), idHeaders());
      }
      const ids = asArr(jsonBody().part_ids).filter((x): x is string => typeof x === "string");
      let total = 0;
      for (const pid of ids) {
        const p = u.parts.get(pid);
        if (!p) return sendError(ctx, "invalid_request", `Unknown part id: ${pid}`);
        total += p.size;
      }
      if (total !== u.bytes) return sendError(ctx, "invalid_request", `The number of bytes uploaded (${total}) does not match the number of bytes specified (${u.bytes}).`);
      u.status = "completed";
      const f = putFile(ctx, { id: mockFileId("openai"), owner: ctx.cred, api: "openai", filename: u.filename, purpose: u.purpose, mime: u.mime, bytes: total, sha256: "", data: null });
      return sendJson(ctx, 200, uploadObj(u, f.object), idHeaders());
    }
    return sendError(ctx, "not_found", `Unknown request URL: ${method} ${path}`);
  }

  // ------------------------------------------------------------------ Gemini
  if (path === "/upload/v1beta/files" && (method === "POST" || method === "PUT")) {
    const command = String(req.headers["x-goog-upload-command"] ?? "").toLowerCase();
    const uploadId = url.searchParams.get("upload_id");
    if (!uploadId) {
      if (String(req.headers["x-goog-upload-protocol"] ?? "").toLowerCase() === "multipart") {
        const f = putFile(ctx, { id: mockFileId("gemini"), owner: ctx.cred, api: "gemini", filename: "upload", purpose: "", mime: ct || "application/octet-stream", bytes: ctx.hashed?.bytes ?? raw.length, sha256: ctx.hashed?.sha256 ?? createHash("sha256").update(raw).digest("hex"), data: null });
        return sendJson(ctx, 200, { file: f.object }, { "x-goog-upload-status": "final", ...idHeaders() });
      }
      if (command !== "start") return sendError(ctx, "invalid_request", "Missing x-goog-upload-command: start.");
      const meta = jsonBody();
      const s: MockGSession = {
        id: `gup${rid()}`,
        owner: ctx.cred,
        mime: String(req.headers["x-goog-upload-header-content-type"] ?? "application/octet-stream"),
        displayName: isObj(meta.file) ? (asStr(meta.file.display_name) ?? asStr(meta.file.displayName) ?? "upload") : "upload",
        received: 0,
      };
      state.gsessions.set(s.id, s);
      res204(ctx, { "x-goog-upload-status": "active", "x-goog-upload-url": `${origin}/upload/v1beta/files?upload_id=${s.id}&upload_protocol=resumable`, "x-goog-upload-chunk-granularity": "8388608", ...idHeaders() });
      return;
    }
    const s = state.gsessions.get(uploadId);
    if (!s || s.owner !== ctx.cred) return sendJson(ctx, 404, { error: { code: 404, message: "Invalid or expired upload session.", status: "NOT_FOUND" } });
    const size = ctx.hashed?.bytes ?? raw.length;
    s.received += size;
    if (command.includes("finalize")) {
      const f = putFile(ctx, {
        id: mockFileId("gemini"),
        owner: ctx.cred,
        api: "gemini",
        filename: s.displayName,
        purpose: "",
        mime: s.mime,
        bytes: s.received,
        sha256: ctx.hashed?.sha256 ?? createHash("sha256").update(raw).digest("hex"),
        data: !ctx.hashed && size <= FILE_KEEP_BYTES ? Buffer.from(raw) : null,
      });
      state.gsessions.delete(uploadId);
      return sendJson(ctx, 200, { file: f.object }, { "x-goog-upload-status": "final", ...idHeaders() });
    }
    return sendJson(ctx, 200, {}, { "x-goog-upload-status": "active" });
  }
  if (path === "/v1beta/files" && method === "GET") {
    const mine = [...state.files.values()].filter((f) => f.api === "gemini" && f.owner === ctx.cred);
    return sendJson(ctx, 200, { files: mine.map((f) => f.object) });
  }
  const gm = /^\/v1beta\/files\/([^/]+)$/.exec(path);
  if (gm) {
    const id = decodeURIComponent(gm[1]);
    const f = ownFile(ctx, "gemini", id);
    if (!f) return fileNotFound(ctx, id);
    if (method === "GET") return sendJson(ctx, 200, f.object, idHeaders());
    if (method === "DELETE") {
      state.files.delete(`gemini:${id}`);
      return sendJson(ctx, 200, {});
    }
  }
  return sendError(ctx, "not_found", `Unknown request URL: ${method} ${path}`);
}

function res204(ctx: Ctx, headers: Record<string, string>): void {
  const res = ctx.res;
  if (res.headersSent || res.destroyed) return;
  res.writeHead(200, { "content-length": 0, ...headers });
  res.end();
}

/** `file_id` / `fileUri` strings anywhere in a request body. */
function referencedFiles(v: unknown, out: Array<{ api: MockFile["api"]; id: string }> = [], key = "", depth = 0): Array<{ api: MockFile["api"]; id: string }> {
  if (depth > 24) return out;
  if (typeof v === "string") {
    if (key === "file_id") out.push({ api: v.startsWith("file_011") ? "anthropic" : "openai", id: v });
    else if (key === "fileUri" || key === "file_uri") {
      const m = /\/files\/([A-Za-z0-9_-]+)/.exec(v);
      if (m) out.push({ api: "gemini", id: m[1] });
    }
  } else if (Array.isArray(v)) for (const x of v) referencedFiles(x, out, key, depth + 1);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) referencedFiles(x, out, k, depth + 1);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Batch APIs: Anthropic /v1/messages/batches, OpenAI /v1/batches
//   A batch ends on the first GET after creation (`[[batchslow]]` in any request keeps it running); `[[batcherr]]` makes
//   that request fail. Results stream line by line (x-mock-delay-ms per line). Batches belong to the creating credential.
// ---------------------------------------------------------------------------------------------------------------------

const isBatchesPath = (path: string) => path === "/v1/messages/batches" || path.startsWith("/v1/messages/batches/") || path === "/v1/batches" || path.startsWith("/v1/batches/");

function anthropicBatchObject(b: MockBatch, origin: string): Obj {
  const ended = b.results !== null;
  const counts = { processing: ended ? 0 : b.requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
  for (const l of b.results ?? []) {
    const t = (JSON.parse(l) as Obj).result as Obj;
    if (t.type === "succeeded") counts.succeeded++;
    else if (t.type === "errored") counts.errored++;
    else if (t.type === "canceled") counts.canceled++;
    else counts.expired++;
  }
  return {
    id: b.id,
    type: "message_batch",
    processing_status: ended ? "ended" : b.canceled ? "canceling" : "in_progress",
    request_counts: counts,
    ended_at: ended ? new Date().toISOString() : null,
    created_at: new Date(b.createdAt).toISOString(),
    expires_at: new Date(b.createdAt + 86_400_000).toISOString(),
    archived_at: null,
    cancel_initiated_at: b.canceled ? new Date().toISOString() : null,
    results_url: ended ? `${origin}/v1/messages/batches/${b.id}/results` : null,
  };
}

function openaiBatchObject(b: MockBatch): Obj {
  const ended = b.results !== null;
  const failed = b.errors?.length ?? 0;
  return {
    id: b.id,
    object: "batch",
    endpoint: b.endpoint,
    errors: null,
    input_file_id: b.inputFileId,
    completion_window: "24h",
    status: ended ? (b.canceled ? "cancelled" : "completed") : b.canceled ? "cancelling" : "in_progress",
    output_file_id: b.outputFileId,
    error_file_id: b.errorFileId,
    created_at: Math.floor(b.createdAt / 1000),
    in_progress_at: Math.floor(b.createdAt / 1000),
    expires_at: Math.floor(b.createdAt / 1000) + 86_400,
    completed_at: ended ? nowSec() : null,
    request_counts: { total: b.requests.length, completed: ended ? (b.results?.length ?? 0) : 0, failed },
    metadata: b.metadata,
    ...(b.requests[0] && isObj(b.requests[0].body) && typeof b.requests[0].body.model === "string" ? { model: b.requests[0].body.model } : {}),
  };
}

/** Run every request of a batch (once): result lines + (OpenAI) output / error files. */
function finishBatch(ctx: Ctx, b: MockBatch): void {
  if (b.results) return;
  const lines: string[] = [];
  const errs: string[] = [];
  for (const r of b.requests) {
    const cid = asStr(r.custom_id) ?? "";
    if (b.api === "anthropic") {
      const params = isObj(r.params) ? r.params : {};
      if (b.canceled) {
        lines.push(JSON.stringify({ custom_id: cid, result: { type: "canceled" } }));
        continue;
      }
      const built = JSON.stringify(params).includes("[[batcherr]]") ? { error: "mock: request failed ([[batcherr]])" } : buildAnthropicMessage(ctx, params);
      if ("error" in built) lines.push(JSON.stringify({ custom_id: cid, result: { type: "errored", error: { type: "error", error: { type: "invalid_request_error", message: built.error } } } }));
      else lines.push(JSON.stringify({ custom_id: cid, result: { type: "succeeded", message: built.message } }));
      continue;
    }
    const body = isObj(r.body) ? r.body : {};
    if (b.canceled) {
      errs.push(JSON.stringify({ id: `batch_req_${rid()}`, custom_id: cid, response: null, error: { code: "batch_cancelled", message: "This request was not executed because the batch was cancelled." } }));
      continue;
    }
    if (JSON.stringify(body).includes("[[batcherr]]")) {
      errs.push(JSON.stringify({ id: `batch_req_${rid()}`, custom_id: cid, response: { status_code: 400, request_id: `req_${rid()}`, body: { error: { message: "mock: request failed ([[batcherr]])", type: "invalid_request_error", param: null, code: null } } }, error: null }));
      continue;
    }
    const p = b.endpoint === "/v1/responses" ? plan(extractResponses(body), "openai", undefined, outputCap(body)) : plan(extractOpenAIChat(body), "openai", undefined, outputCap(body));
    const out: Obj =
      b.endpoint === "/v1/responses"
        ? { id: `resp_mock_${rid()}`, object: "response", status: "completed", model: body.model, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: p.text }] }], usage: responsesUsage(p.usage) }
        : { id: `chatcmpl-mock-${rid()}`, object: "chat.completion", created: nowSec(), model: body.model, choices: [{ index: 0, message: { role: "assistant", content: p.text }, finish_reason: "stop" }], usage: openaiUsage(p.usage) };
    lines.push(JSON.stringify({ id: `batch_req_${rid()}`, custom_id: cid, response: { status_code: 200, request_id: `req_${rid()}`, body: out }, error: null }));
  }
  b.results = lines;
  b.errors = errs;
  if (b.api === "openai") {
    const mk = (rows: string[], kind: string): string | null => {
      if (!rows.length) return null;
      const data = Buffer.from(rows.join("\n") + "\n");
      const f = putFile(ctx, { id: mockFileId("openai"), owner: b.owner, api: "openai", filename: `${b.id}_${kind}.jsonl`, purpose: `batch_${kind}`, mime: "application/jsonl", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), data });
      return f.id;
    };
    b.outputFileId = mk(lines, "output");
    b.errorFileId = mk(errs, "error");
  }
}

async function handleBatches(ctx: Ctx, raw: Buffer): Promise<void> {
  const { req, path, state } = ctx;
  const method = (req.method ?? "GET").toUpperCase();
  const api: MockBatch["api"] = path.startsWith("/v1/messages/") ? "anthropic" : "openai";
  const root = api === "anthropic" ? "/v1/messages/batches" : "/v1/batches";
  const body = (): Obj => {
    try {
      const v: unknown = raw.length ? JSON.parse(raw.toString("utf8")) : {};
      return isObj(v) ? v : {};
    } catch {
      return {};
    }
  };
  const view = (b: MockBatch) => (api === "anthropic" ? anthropicBatchObject(b, originOf(ctx)) : openaiBatchObject(b));
  const notFound = (id: string) =>
    api === "anthropic"
      ? sendJson(ctx, 404, { type: "error", error: { type: "not_found_error", message: `Message batch not found: ${id}` }, request_id: `req_mock_${rid()}` })
      : sendJson(ctx, 404, { error: { message: `No batch found with id '${id}'.`, type: "invalid_request_error", param: null, code: null } });

  if (path === root) {
    if (method === "GET") {
      const mine = [...state.batches.values()].filter((b) => b.api === api && b.owner === ctx.cred).sort((a, b) => b.createdAt - a.createdAt);
      const data = mine.map(view);
      return sendJson(ctx, 200, api === "anthropic" ? { data, has_more: false, first_id: mine[0]?.id ?? null, last_id: mine[mine.length - 1]?.id ?? null } : { object: "list", data, has_more: false });
    }
    const b = body();
    let requests: Obj[];
    let endpoint = "/v1/messages";
    let inputFileId: string | null = null;
    if (api === "anthropic") {
      requests = asArr(b.requests).filter(isObj);
      if (!requests.length) return sendError(ctx, "invalid_request", "requests: Field required");
    } else {
      inputFileId = asStr(b.input_file_id) ?? null;
      endpoint = asStr(b.endpoint) ?? "";
      const f = inputFileId ? ownFile(ctx, "openai", inputFileId) : null;
      if (!f || !f.data) return fileNotFound(ctx, inputFileId ?? "");
      requests = f.data
        .toString("utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as Obj);
    }
    const batch: MockBatch = {
      id: api === "anthropic" ? `msgbatch_mock${rid()}` : `batch_mock${rid()}`,
      api,
      owner: ctx.cred,
      createdAt: Date.now(),
      requests,
      endpoint,
      inputFileId,
      polls: 0,
      slow: raw.includes("[[batchslow]]") || requests.some((r) => JSON.stringify(r).includes("[[batchslow]]")),
      canceled: false,
      results: null,
      errors: null,
      outputFileId: null,
      errorFileId: null,
      metadata: isObj(b.metadata) ? b.metadata : null,
    };
    state.batches.set(batch.id, batch);
    return sendJson(ctx, 200, view(batch));
  }

  const m = new RegExp(`^${root.replace(/\//g, "\\/")}\\/([^/]+)(?:\\/(results|cancel))?$`).exec(path);
  if (!m) return sendError(ctx, "not_found", `Unknown request URL: ${method} ${path}`);
  const id = decodeURIComponent(m[1]);
  const b = state.batches.get(id);
  if (!b || b.owner !== ctx.cred || b.api !== api) return notFound(id);
  const sub = m[2];
  if (sub === "cancel") {
    b.canceled = true;
    if (!b.slow) finishBatch(ctx, b);
    return sendJson(ctx, 200, view(b));
  }
  if (sub === "results") {
    if (!b.results) return sendError(ctx, "invalid_request", `Batch ${id} has not ended yet.`);
    const delay = resolveDelay(req, null, noMarkers);
    ctx.res.writeHead(200, { "content-type": "application/binary", ...idHeaders() });
    ctx.phase = "streaming";
    for (const line of b.results) {
      if (!(await sleep(ctx, delay))) return;
      if (ctx.res.destroyed) return;
      await writeFlushed(ctx, ctx.res, line + "\n");
      ctx.frames++;
    }
    ctx.res.end();
    return;
  }
  if (method === "DELETE") {
    if (!b.results) return sendError(ctx, "invalid_request", `Batch ${id} cannot be deleted while it is still processing.`);
    state.batches.delete(id);
    return sendJson(ctx, 200, { id, type: "message_batch_deleted" });
  }
  b.polls++;
  if ((!b.slow || b.canceled) && b.polls >= 1) finishBatch(ctx, b);
  return sendJson(ctx, 200, view(b));
}

// ---------------------------------------------------------------------------------------------------------------------
// auth & dispatch
// ---------------------------------------------------------------------------------------------------------------------

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  const m = typeof h === "string" ? /^(?:Bearer|Key)\s+(.+)$/i.exec(h) : null;
  return m ? m[1].trim() : null;
}
const hdr = (req: http.IncomingMessage, name: string): string | null => {
  const v = req.headers[name];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() ? s.trim() : null;
};

/** Credential in the style each surface expects, or null when absent / wrong style for the surface. */
function credentialFor(surface: Surface, req: http.IncomingMessage, url: URL): string | null {
  if (surface === "anthropic") return hdr(req, "x-api-key") ?? bearer(req);
  if (surface === "gemini") return hdr(req, "x-goog-api-key") ?? (url.searchParams.get("key") || null) ?? bearer(req);
  return bearer(req) ?? hdr(req, "api-key");
}

function authMessage(surface: Surface): string {
  if (surface === "anthropic") return "x-api-key header is required";
  if (surface === "gemini") return "API key not valid. Please pass a valid API key.";
  return "You didn't provide an API key. You need to provide your API key in an Authorization: Bearer header.";
}

const GEMINI_RE = /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents)$/;
const RESPONSES_RE = /^\/v1\/responses\/([^/]+)(?:\/(cancel|input_items))?$/;

async function route(ctx: Ctx, raw: Buffer): Promise<void> {
  const { req, path, surface } = ctx;
  const method = (req.method ?? "GET").toUpperCase();

  const extraKind = extraKindOf(path);
  if (extraKind) return handleExtra(ctx, extraKind, raw);

  // 404 for unknown paths before auth (so a typo is obvious)
  const gem = GEMINI_RE.exec(path);
  const resp = RESPONSES_RE.exec(path);
  const modelOne = /^\/v1\/models\/([^/]+)$/.exec(path);
  const gemModelOne = /^\/v1beta\/models\/([^/:]+)$/.exec(path);
  const postRoutes = new Set([
    "/v1/chat/completions",
    "/v1beta/openai/chat/completions",
    "/v1/completions",
    "/v1/responses",
    "/v1/embeddings",
    "/v1/images/generations",
    "/v1/images/edits",
    "/v1/images/variations",
    "/v1/audio/speech",
    "/v1/audio/transcriptions",
    "/v1/audio/translations",
    "/v1/moderations",
    "/v1/messages",
    "/v1/messages/count_tokens",
  ]);
  const known =
    (method === "POST" && (postRoutes.has(path) || !!gem)) ||
    (method === "GET" && (path === "/v1/models" || path === "/v1/model/info" || !!modelOne || path === "/v1beta/models" || !!gemModelOne)) ||
    !!resp ||
    isFilesPath(path) ||
    isBatchesPath(path);
  if (!known) return sendError(ctx, "not_found", `Unknown request URL: ${method} ${path}`);

  // --- auth (per-surface header style) ---
  const cred = credentialFor(surface, req, ctx.url);
  if (!cred) return sendError(ctx, "auth", authMessage(surface));
  const slow = cred.includes("slow");
  if (slow && !(await sleep(ctx, 1500))) return;
  if (cred.includes("bad")) return sendError(ctx, "auth", "Incorrect API key provided.");
  // (the messages are what a real provider says: the gateway forwards them to the client, so they must not name the fault key)
  if (cred.includes("fail429")) return sendError(ctx, "rate_limit", "Rate limit reached for requests.", { ...rateLimitHeaders(ctx), ...idHeaders() });
  if (cred.includes("deny403")) return sendError(ctx, "invalid_request", `This group does not allow ${path} dispatch`, idHeaders(), 403);
  if (cred.includes("fail500")) return sendError(ctx, "server", "The server had an error while processing your request.", idHeaders());
  if (cred.includes("fail529")) return sendError(ctx, "overloaded", "Overloaded.", idHeaders());
  // x-mock-fail: <status> - any HTTP status, retry-after 7 + request id, native error body
  const failStatus = Number(hdr(req, "x-mock-fail"));
  if (Number.isInteger(failStatus) && failStatus >= 400 && failStatus < 600) {
    const kind: ErrKind = failStatus === 429 ? "rate_limit" : failStatus === 401 ? "auth" : failStatus === 404 ? "not_found" : failStatus === 529 ? "overloaded" : failStatus < 500 ? "invalid_request" : "server";
    const rl = failStatus === 429 ? { ...rateLimitHeaders(ctx), "retry-after": "7" } : { "retry-after": "7" };
    return sendError(ctx, kind, failStatus === 429 ? "Rate limit reached for requests." : failStatus === 529 ? "Overloaded." : failStatus >= 500 ? "The server had an error while processing your request." : "The request was rejected.", { ...rl, ...idHeaders() }, failStatus);
  }

  if (surface === "anthropic" && !hdr(req, "anthropic-version")) {
    return sendError(ctx, "invalid_request", "anthropic-version: header is required");
  }
  ctx.cred = cred;

  // files referenced by the request must belong to this credential (the gateway has to pin the request to the right account)
  if (method === "POST" && !isFilesPath(path) && !isBatchesPath(path) && /^application\/json/i.test(String(req.headers["content-type"] ?? "")) && raw.length > 0 && raw.length < 8 * 1024 * 1024) {
    try {
      const v: unknown = JSON.parse(raw.toString("utf8"));
      for (const ref of referencedFiles(v)) {
        if (!ownFile(ctx, ref.api, ref.id)) return fileNotFound(ctx, ref.id);
      }
    } catch {
      /* reported below */
    }
  }
  if (isFilesPath(path)) return handleFilesApi(ctx, raw);
  if (isBatchesPath(path)) return handleBatches(ctx, raw);

  // --- GETs / bodiless ---
  if (method === "GET") {
    if (path === "/v1/models") return handleModels(ctx);
    // LiteLLM-style price list (what a reseller / proxy publishes): USD per token
    if (path === "/v1/model/info")
      return sendJson(ctx, 200, {
        data: [
          { model_name: "gpt-mock", model_info: { input_cost_per_token: 0.0000025, output_cost_per_token: 0.00001, cache_read_input_token_cost: 0.00000125, max_input_tokens: 128000, max_output_tokens: 16384 } },
          { model_name: "image-mock", model_info: { output_cost_per_image: 0.04 } },
        ],
      });
    if (modelOne) return handleModels(ctx, decodeURIComponent(modelOne[1]));
    if (path === "/v1beta/models") return handleGeminiModels(ctx);
    if (gemModelOne) return handleGeminiModels(ctx, decodeURIComponent(gemModelOne[1]));
  }
  if (resp) return handleResponsesAux(ctx, method, decodeURIComponent(resp[1]), resp[2]);

  // --- POSTs ---
  let parsed: Parsed;
  try {
    parsed = ctx.hashed ? hashedParse(ctx) : parseBody(raw, String(req.headers["content-type"] ?? ""));
  } catch (e) {
    return sendError(ctx, "invalid_request", e instanceof BadBody ? e.message : "Invalid request body");
  }
  const b = parsed.json ?? {};
  if (raw.includes("[[http400]]")) return sendError(ctx, "invalid_request", "mock: request rejected ([[http400]])");

  // non-chat endpoints honour x-mock-delay-ms too (a slow upstream: lets tests abort while the gateway waits for it)
  if (/^\/v1\/(images|audio|embeddings|moderations)/.test(path)) {
    const d = resolveDelay(req, null, noMarkers);
    if (d > 0 && !(await sleep(ctx, d))) return;
  }

  if (gem) return handleGemini(ctx, decodeURIComponent(gem[1]), gem[2], b);
  switch (path) {
    case "/v1/chat/completions":
    case "/v1beta/openai/chat/completions":
      return handleChat(ctx, b);
    case "/v1/completions":
      return handleCompletions(ctx, b);
    case "/v1/responses":
      return handleResponses(ctx, b);
    case "/v1/embeddings":
      return handleEmbeddings(ctx, b);
    case "/v1/images/generations":
    case "/v1/images/edits":
    case "/v1/images/variations":
      return handleImages(ctx, parsed);
    case "/v1/audio/speech":
      return handleSpeech(ctx, b);
    case "/v1/audio/transcriptions":
      return handleTranscription(ctx, parsed, false);
    case "/v1/audio/translations":
      return handleTranscription(ctx, parsed, true);
    case "/v1/moderations":
      return handleModeration(ctx, b);
    case "/v1/messages":
      return handleAnthropicMessages(ctx, b);
    case "/v1/messages/count_tokens":
      return handleAnthropicCountTokens(ctx, b);
    default:
      return sendError(ctx, "not_found", `Unknown request URL: ${method} ${path}`);
  }
}

function introspect(state: MockState, res: http.ServerResponse, url: URL, path: string): boolean {
  const json = (status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  };
  if (path === "/healthz") {
    json(200, { ok: true });
    return true;
  }
  if (path === "/__mock/stats") {
    json(200, {
      total: state.total,
      inflight: state.inflight,
      maxInflight: state.maxInflight,
      byKey: Object.fromEntries(state.byKey),
      byPath: Object.fromEntries(state.byPath),
    });
    return true;
  }
  if (path === "/__mock/reset") {
    resetState(state);
    json(200, { ok: true });
    return true;
  }
  if (path === "/__mock/last") {
    const want = url.searchParams.get("path") ?? "";
    const rec = state.last.get(want);
    if (!rec) json(404, { error: `no request recorded for path '${want}'` });
    else json(200, rec);
    return true;
  }
  if (path === "/__mock/aborts") {
    const tag = url.searchParams.get("tag");
    json(200, { now: Date.now(), aborts: tag ? state.aborts.filter((a) => a.tag === tag) : state.aborts });
    return true;
  }
  return false;
}

/** Streaming-hash mode: the request is never buffered, only counted and hashed (huge uploads). */
async function hashBody(req: http.IncomingMessage, ct: string): Promise<{ sha256: string; bytes: number; scan: MultipartScanner | null }> {
  const h = createHash("sha256");
  let bytes = 0;
  const boundary = /multipart\/form-data/i.test(ct) ? boundaryOf(ct) : null;
  const scan = boundary ? new MultipartScanner(boundary) : null;
  for await (const c of req) {
    const b = typeof c === "string" ? Buffer.from(c) : (c as Buffer);
    h.update(b);
    bytes += b.length;
    try {
      scan?.push(b);
    } catch {
      /* malformed multipart: reported by the handler */
    }
  }
  return { sha256: h.digest("hex"), bytes, scan };
}

function wantsHash(req: http.IncomingMessage): boolean {
  if (hdr(req, "x-mock-hash-body")) return true;
  const len = Number(req.headers["content-length"]);
  return Number.isFinite(len) && len > 32 * 1024 * 1024;
}

/** What the handlers see for a streamed body: the multipart structure, or a canned chat-like JSON request. */
function hashedParse(ctx: Ctx): Parsed {
  const ct = String(ctx.req.headers["content-type"] ?? "");
  if (/multipart\/form-data/i.test(ct)) {
    const sc = ctx.scan;
    return {
      json: null,
      multipart: {
        fields: Object.fromEntries((sc?.fields ?? []).map((f) => [f.name, f.value])),
        files: (sc?.files ?? []).map((f) => ({ name: f.name, filename: f.filename, size: f.size })),
      },
    };
  }
  const text = "[[usage:in=10,out=5]] hashed body";
  const stream = String(ctx.req.headers["x-mock-hash-stream"] ?? "") === "1";
  return { json: { model: "hash-model", messages: [{ role: "user", content: text }], input: text, prompt: text, contents: [{ role: "user", parts: [{ text }] }], max_tokens: 64, stream }, multipart: null };
}

async function handle(state: MockState, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://mock.local");
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  req.on("error", () => undefined);
  res.on("error", () => undefined);

  if (isIntrospection(path)) {
    if (introspect(state, res, url, path)) return;
  }

  const surface = surfaceOf(path, req);
  const key = credentialFor(surface, req, url) ?? "(none)";
  const ctx: Ctx = {
    req,
    res,
    url,
    path,
    surface,
    closed: false,
    waiters: new Set(),
    state,
    fault: parseFault(req),
    phase: "uploading",
    frames: 0,
    selfDestroyed: false,
    tag: hdr(req, "x-mock-tag"),
    cred: key,
    hashed: null,
    scan: null,
  };
  const done = track(state, key, path);
  res.on("close", () => {
    ctx.closed = true;
    for (const w of [...ctx.waiters]) w();
    ctx.waiters.clear();
    done();
    // the other side hung up before the mock finished answering (client abort / gateway abort)
    if (!res.writableFinished && !ctx.selfDestroyed) state.aborts.push({ tag: ctx.tag, path, key, phase: ctx.phase, frames: ctx.frames, at: Date.now() });
  });

  try {
    const ct = String(req.headers["content-type"] ?? "");
    let raw: Buffer;
    if (wantsHash(req)) {
      const h = await hashBody(req, ct);
      if (ctx.closed) return;
      ctx.hashed = { sha256: h.sha256, bytes: h.bytes };
      ctx.scan = h.scan;
      raw = Buffer.alloc(0);
    } else {
      raw = await readBody(req);
      if (ctx.closed) return;
    }
    ctx.phase = "waiting";
    // record for /__mock/last (auth failures included, so tests can inspect what the gateway sent)
    let body: unknown = null;
    let multipart: LastRequest["multipart"] = null;
    try {
      if (ctx.hashed) {
        const sc = ctx.scan;
        if (sc) multipart = { fields: Object.fromEntries(sc.fields.map((f) => [f.name, f.value])), files: sc.files.map((f) => ({ name: f.name, filename: f.filename, size: f.size })) };
      } else if (/multipart\/form-data/i.test(ct)) multipart = parseMultipart(raw, ct);
      else if (raw.length > 0) body = JSON.parse(raw.toString("utf8"));
    } catch {
      /* malformed JSON is reported to the caller below */
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : (v ?? "");
    state.last.set(path, {
      path,
      method: req.method ?? "GET",
      query: Object.fromEntries(url.searchParams),
      headers,
      body,
      multipart,
      ...(ctx.hashed ? { bodySha256: ctx.hashed.sha256, bodyBytes: ctx.hashed.bytes } : raw.length ? { bodySha256: createHash("sha256").update(raw).digest("hex"), bodyBytes: raw.length } : {}),
      at: new Date().toISOString(),
    });
    await route(ctx, raw);
  } catch (e) {
    if (!res.headersSent && !res.destroyed) {
      const msg = e instanceof Error ? e.message : "mock upstream error";
      try {
        sendError(ctx, "server", `mock upstream internal error: ${msg}`);
      } catch {
        res.destroy();
      }
    } else if (!res.destroyed) {
      res.destroy();
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------------------------------------------------

export async function startMockUpstream(
  port: number = Number(process.env.MOCK_UPSTREAM_PORT ?? 4010),
  host: string = "0.0.0.0",
): Promise<{ server: http.Server; port: number; close(): Promise<void> }> {
  const state = createState();
  const server = http.createServer((req, res) => {
    handle(state, req, res).catch(() => {
      if (!res.destroyed) res.destroy();
    });
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 35_000;
  server.requestTimeout = 0; // long streams must not be cut off
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port, host, backlog: 4096 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const actualPort = (server.address() as AddressInfo).port;
  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Auto-start only when executed as a script (tsx scripts/mock-upstream.ts), never when imported (vitest).
if (/mock-upstream\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? "")) {
  startMockUpstream()
    .then(({ port, close }) => {
      console.log(`[mock-upstream] listening on http://localhost:${port}  (OpenAI /v1, Anthropic /v1/messages, Gemini /v1beta)`);
      const stop = () => void close().finally(() => process.exit(0));
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    })
    .catch((err) => {
      console.error("[mock-upstream] failed to start:", err);
      process.exit(1);
    });
}
