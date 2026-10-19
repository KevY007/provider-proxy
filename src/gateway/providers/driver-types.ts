import type { Ctx } from "../context";
import type { GatewayErrorCode } from "../errors";
import type { FailureKind } from "../keyhealth";
import type { Candidate } from "../select";
import type { HeaderLike } from "../shape";
import type { Json, JsonObject, Usage } from "../types";

/**
 * Provider "drivers": adapters for upstreams whose API is not a single HTTP exchange in an OpenAI-compatible shape
 * (fal.ai: sync + queue/poll, Replicate: prediction + poll, plus result download). A driver receives a ready-made
 * environment (auth headers, timeouts, client-abort propagation) and returns the finished OpenAI-shaped body +
 * normalised usage. The pipeline (execute.ts) keeps doing slots, key selection, failover, metering and logging.
 */

/** A non-2xx upstream HTTP answer (classified by the pipeline: failover vs. client error). */
export class UpstreamHttpError extends Error {
  constructor(
    readonly status: number,
    readonly headers: HeaderLike,
    readonly body: string,
  ) {
    super(`upstream HTTP ${status}`);
    this.name = "UpstreamHttpError";
  }
}

/** Transport / protocol failure of the upstream (timeout, network, bad payload): triggers failover. */
export class DriverFailure extends Error {
  constructor(
    readonly fk: FailureKind,
    readonly status: number,
    message: string,
    readonly internal?: string,
  ) {
    super(message);
    this.name = "DriverFailure";
  }
}

/**
 * Final answer, never retried on another key. By default the customer's request is wrong or unsupported (message is
 * customer-safe); with `kind: "upstream"` it is a deterministic upstream failure (e.g. a failed prediction) that is
 * not worth paying for twice: logged as UPSTREAM_ERROR but without penalising the upstream key.
 */
export class DriverClientError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: GatewayErrorCode = "invalid_request",
    readonly param?: string,
    readonly opts: { kind?: "client" | "upstream"; internal?: string } = {},
  ) {
    super(message);
    this.name = "DriverClientError";
  }
}

export interface HttpReq {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers: Record<string, string>;
  body?: string;
  /** Per-call cap (always bounded by the remaining provider timeout). */
  timeoutMs?: number;
}

export interface HttpRes {
  status: number;
  headers: HeaderLike;
  text: string;
}

export interface DriverEnv {
  ctx: Ctx;
  cand: Candidate;
  /** Wall-clock deadline (ms) = attempt start + provider.timeoutMs. */
  deadline: number;
  /** Upstream auth + default headers (fal: "Authorization: Key"). `hasBody=false` drops content-type. */
  headers(hasBody: boolean): Record<string, string>;
  /** One HTTP exchange; non-2xx is returned, transport problems throw DriverFailure, client abort throws ClientAbortError. */
  request(req: HttpReq): Promise<HttpRes>;
  /** `request` + 2xx check + JSON parse. Throws UpstreamHttpError on non-2xx. */
  json(req: HttpReq): Promise<Json>;
  /** Download a (public) result file; supports data: URIs. */
  download(url: string, maxBytes?: number): Promise<{ data: Buffer; contentType: string }>;
  /** Abortable sleep (throws ClientAbortError when the client went away). */
  sleep(ms: number): Promise<void>;
}

export interface DriverResult {
  status: number;
  body: Json;
  usage: Usage;
  /** videos_create: backend-specific job data stored in VideoJob.meta (queue URLs...). */
  meta?: JsonObject;
}

export interface Driver {
  name: string;
  run(env: DriverEnv): Promise<DriverResult>;
}
