import { ClientAbortError } from "../upstream";
import type { Json, JsonObject } from "../types";
import { isObject } from "../util";
import { DriverFailure, UpstreamHttpError, type Driver, type DriverEnv, type DriverResult } from "./driver-types";
import { falImageSize, finishInput, imageResult, parseImageRequest, pollDelay, sameOrigin, str, toImageData, trimSlash } from "./image-common";

/**
 * fal.ai image driver (`openai_images` -> POST /v1/images/generations).
 *
 *   sync  : POST {baseUrl}/{model}          (https://fal.run/fal-ai/flux/schnell) - answers when the image is ready
 *   queue : POST {queueBaseUrl}/{model}     (https://queue.fal.run/...) -> poll status_url -> GET response_url
 *   auth  : Authorization: Key <key>        (applied by providers/adapters.ts, keyed on preset "fal")
 *
 * Provider.settings.falMode: "sync" | "queue" | "auto" (default). auto = sync first, and fall back to the queue when
 * the sync call times out (HTTP 408/504/524 or our own sync timeout, Provider.settings.falSyncTimeoutMs, 60s).
 */
export type FalMode = "sync" | "queue" | "auto";

export function falMode(settings: JsonObject): FalMode {
  return settings.falMode === "sync" || settings.falMode === "queue" ? settings.falMode : "auto";
}

function isSyncTimeout(e: unknown): boolean {
  if (e instanceof DriverFailure) return e.fk === "timeout";
  if (e instanceof UpstreamHttpError) return e.status === 408 || e.status === 504 || e.status === 524;
  return false;
}

function buildInput(env: DriverEnv): { input: JsonObject; format: "url" | "b64_json" } {
  const req = parseImageRequest(env.ctx.body);
  const input: JsonObject = { prompt: req.prompt };
  if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
  if (req.size) input.image_size = falImageSize(req.size);
  if (req.n > 1) input.num_images = req.n;
  if (req.seed !== null) input.seed = req.seed;
  if (req.outputFormat === "png" || req.outputFormat === "jpeg") input.output_format = req.outputFormat;
  finishInput(input, req, env.cand.route.paramOverrides);
  return { input, format: req.format };
}

/** fal reports an empty balance as 403 "User is locked" - that is a billing problem of OUR account, not a bad key. */
export async function falCall(env: DriverEnv, req: Parameters<DriverEnv["json"]>[0]): Promise<Json> {
  try {
    return await env.json(req);
  } catch (e) {
    if (e instanceof UpstreamHttpError && e.status === 403 && /balance|locked|exhaust/i.test(e.body)) throw new UpstreamHttpError(402, e.headers, e.body);
    throw e;
  }
}

async function runQueue(env: DriverEnv, queueBase: string, model: string, input: JsonObject): Promise<Json> {
  const app = model.split("/").slice(0, 2).join("/");
  const sub = await falCall(env, { url: `${queueBase}/${model}`, method: "POST", headers: env.headers(true), body: JSON.stringify(input) });
  const requestId = isObject(sub) ? str(sub.request_id) : undefined;
  if (!requestId) throw new DriverFailure("server", 200, "queue submit returned no request_id", JSON.stringify(sub).slice(0, 500));
  const idPath = encodeURIComponent(requestId);
  // trust the URLs fal returned only when they point at the queue origin (never send our key elsewhere)
  const pick = (u: unknown, fallback: string) => (typeof u === "string" && sameOrigin(u, queueBase) ? u : fallback);
  const statusUrl = pick(isObject(sub) ? sub.status_url : undefined, `${queueBase}/${app}/requests/${idPath}/status`);
  const responseUrl = pick(isObject(sub) ? sub.response_url : undefined, `${queueBase}/${app}/requests/${idPath}`);
  const cancelUrl = `${queueBase}/${app}/requests/${idPath}/cancel`;

  try {
    for (let i = 0; ; i++) {
      const st = await falCall(env, { url: statusUrl, method: "GET", headers: env.headers(false) });
      const status = isObject(st) ? st.status : undefined;
      if (status === "COMPLETED") break;
      if (status !== "IN_QUEUE" && status !== "IN_PROGRESS") throw new DriverFailure("server", 200, `unexpected queue status '${String(status)}'`, JSON.stringify(st).slice(0, 500));
      await env.sleep(pollDelay(i));
    }
    return await falCall(env, { url: responseUrl, method: "GET", headers: env.headers(false) });
  } catch (e) {
    if (e instanceof ClientAbortError || (e instanceof DriverFailure && e.fk === "timeout")) {
      // do not keep paying for a job nobody is waiting for (best effort)
      env.request({ url: cancelUrl, method: "PUT", headers: env.headers(false), timeoutMs: 5000 }).catch(() => undefined);
    }
    throw e;
  }
}

function extractImageUrls(result: Json): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (isObject(v) && typeof v.url === "string") out.push(v.url);
  };
  if (isObject(result)) {
    if (Array.isArray(result.images)) result.images.forEach(add);
    else if (result.image !== undefined) add(result.image);
    else if (isObject(result.output) && Array.isArray(result.output.images)) result.output.images.forEach(add);
    else if (Array.isArray(result.output)) result.output.forEach(add);
  }
  return out;
}

export const falImagesDriver: Driver = {
  name: "fal.images",
  async run(env: DriverEnv): Promise<DriverResult> {
    const provider = env.cand.route.provider;
    const model = env.cand.route.upstreamModel.replace(/^\/+|\/+$/g, "");
    const { input, format } = buildInput(env);
    const base = trimSlash(provider.baseUrl);
    const queueBase = trimSlash(str(provider.settings.queueBaseUrl) ?? "https://queue.fal.run");
    const mode = falMode(provider.settings);

    let result: Json;
    if (mode === "queue") {
      result = await runQueue(env, queueBase, model, input);
    } else {
      const syncMs = mode === "auto" ? Math.max(1000, Number(provider.settings.falSyncTimeoutMs) || 60_000) : undefined;
      try {
        result = await falCall(env, { url: `${base}/${model}`, method: "POST", headers: env.headers(true), body: JSON.stringify(input), timeoutMs: syncMs });
      } catch (e) {
        if (mode === "auto" && isSyncTimeout(e)) result = await runQueue(env, queueBase, model, input);
        else throw e;
      }
    }

    const urls = extractImageUrls(result);
    if (!urls.length) throw new DriverFailure("server", 200, "fal returned no images", JSON.stringify(result).slice(0, 500));
    return imageResult(await toImageData(env, urls, format));
  },
};
