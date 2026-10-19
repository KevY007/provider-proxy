import { assertPublicUrl, hostOf } from "../ssrf";
import type { Ctx } from "../context";
import type { Candidate } from "../select";
import { ClientAbortError, UpstreamTimeoutError, readBytesLimited, readTextLimited, sendUpstream, type UpstreamHandle } from "../upstream";
import { describeNetworkError, safeJsonParse, sleep } from "../util";
import { buildUpstreamHeaders } from "./adapters";
import { DriverFailure, UpstreamHttpError, type DriverEnv, type HttpReq, type HttpRes } from "./driver-types";

const MAX_JSON = 64 * 1024 * 1024;
const MAX_DOWNLOAD = 50 * 1024 * 1024;

/** Build the environment a Driver runs in (auth, deadline, abort propagation, bounded reads). */
export function makeDriverEnv(ctx: Ctx, cand: Candidate, secret: string, t0: number): DriverEnv {
  const provider = cand.route.provider;
  const deadline = t0 + provider.timeoutMs;
  const signal = ctx.req.signal;

  const headers = (hasBody: boolean) =>
    buildUpstreamHeaders({ provider, format: "openai_images", secret, stream: false, keyExtra: cand.key.extra, hasBody, contentType: hasBody ? "application/json" : null });

  const remaining = (): number => {
    const r = deadline - Date.now();
    if (r <= 0) throw new DriverFailure("timeout", 0, `no result within ${provider.timeoutMs}ms`);
    return r;
  };

  async function request(req: HttpReq): Promise<HttpRes> {
    if (signal.aborted) throw new ClientAbortError();
    const timeoutMs = Math.max(1, Math.min(req.timeoutMs ?? Infinity, remaining()));
    let h: UpstreamHandle;
    try {
      h = await sendUpstream({ url: req.url, method: req.method, headers: req.headers, body: req.body ?? null, timeoutMs, clientSignal: signal });
    } catch (err) {
      if (err instanceof ClientAbortError) throw err;
      if (err instanceof UpstreamTimeoutError) throw new DriverFailure("timeout", 0, `no response within ${timeoutMs}ms`);
      throw new DriverFailure("network", 0, describeNetworkError(err));
    }
    const timer = setTimeout(() => h.abort(new UpstreamTimeoutError("idle")), timeoutMs);
    try {
      const text = await readTextLimited(h.res, MAX_JSON);
      return { status: h.res.status, headers: h.res.headers, text };
    } catch (err) {
      if (signal.aborted || err instanceof ClientAbortError || h.signal.reason instanceof ClientAbortError) throw new ClientAbortError();
      if (h.signal.reason instanceof UpstreamTimeoutError) throw new DriverFailure("timeout", 0, "timed out reading the upstream response");
      throw new DriverFailure("network", 0, `failed reading upstream response: ${describeNetworkError(err)}`);
    } finally {
      clearTimeout(timer);
      h.dispose();
    }
  }

  async function json(req: HttpReq) {
    const res = await request(req);
    if (res.status < 200 || res.status >= 300) throw new UpstreamHttpError(res.status, res.headers, res.text);
    const parsed = safeJsonParse(res.text);
    if (parsed === undefined) throw new DriverFailure("server", res.status, "upstream returned a non-JSON response", res.text.slice(0, 500));
    return parsed;
  }

  async function download(url: string, maxBytes = MAX_DOWNLOAD): Promise<{ data: Buffer; contentType: string }> {
    if (url.startsWith("data:")) {
      const m = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/.exec(url);
      if (!m) throw new DriverFailure("server", 200, "upstream returned a malformed data URI");
      const data = /;base64/i.test(m[2]) ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
      return { data, contentType: m[1] || "application/octet-stream" };
    }
    if (!/^https?:\/\//i.test(url)) throw new DriverFailure("server", 200, "upstream returned an unsupported result URL");
    try {
      await assertPublicUrl(url, [hostOf(provider.baseUrl), hostOf(typeof provider.settings.queueBaseUrl === "string" ? provider.settings.queueBaseUrl : null)]);
    } catch {
      throw new DriverFailure("server", 200, "upstream returned a result URL on a private address (refused)", url.slice(0, 300));
    }
    let h: UpstreamHandle;
    try {
      h = await sendUpstream({ url, method: "GET", headers: { accept: "*/*", "user-agent": "ProviderProxy/1.0" }, timeoutMs: Math.min(remaining(), 60_000), clientSignal: signal });
    } catch (err) {
      if (err instanceof ClientAbortError) throw err;
      if (err instanceof UpstreamTimeoutError) throw new DriverFailure("timeout", 0, "timed out downloading the generated file");
      throw new DriverFailure("network", 0, `could not download the generated file: ${describeNetworkError(err)}`);
    }
    try {
      if (h.res.status < 200 || h.res.status >= 300) throw new DriverFailure("server", h.res.status, `could not download the generated file (HTTP ${h.res.status})`);
      const data = await readBytesLimited(h.res, maxBytes);
      return { data, contentType: h.res.headers.get("content-type") ?? "application/octet-stream" };
    } catch (err) {
      if (err instanceof DriverFailure || err instanceof ClientAbortError) throw err;
      if (signal.aborted) throw new ClientAbortError();
      throw new DriverFailure("network", 0, `could not download the generated file: ${describeNetworkError(err)}`);
    } finally {
      h.dispose();
    }
  }

  async function wait(ms: number): Promise<void> {
    await sleep(ms, signal);
    if (signal.aborted) throw new ClientAbortError();
  }

  return { ctx, cand, deadline, headers, request, json, download, sleep: wait };
}
