import { getField } from "../multipart";
import type { Json, JsonObject } from "../types";
import { emptyUsage } from "../types";
import { deepMerge, isObject, safeJsonParse } from "../util";
import { requestedSeconds, requestedSize } from "../video";
import { DriverClientError, DriverFailure, type Driver, type DriverEnv, type DriverResult } from "./driver-types";
import { falCall } from "./fal";
import { sameOrigin, str, trimSlash } from "./image-common";

/**
 * fal.ai video driver (`openai_videos` -> POST /v1/videos): submits the job to fal's QUEUE API and returns immediately
 * with an OpenAI-style `queued` video object; status polling, the result URL and cancellation live in video.ts.
 *
 * Input mapping (override anything with `extra_input`; the route's paramOverrides win last):
 *   prompt            -> prompt
 *   seconds           -> duration (string, e.g. "5"; models that want "8s" need extra_input.duration)
 *   size "WxH"        -> aspect_ratio (16:9 | 9:16 | 1:1)
 *   input_reference   -> image_url (multipart file as data URI, or a URL / {image_url} in JSON)
 *
 * Billing is by the requested `seconds` (the same value is sent as `duration`), see finishVideoCreate().
 */
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

function videoAspect(w: number, h: number): string {
  const r = w / h;
  const options: Array<[string, number]> = [
    ["16:9", 16 / 9],
    ["9:16", 9 / 16],
    ["1:1", 1],
  ];
  return options.reduce((best, o) => (Math.abs(Math.log(r / o[1])) < Math.abs(Math.log(r / best[1])) ? o : best))[0];
}

export const falVideoCreateDriver: Driver = {
  name: "fal.video.create",
  async run(env: DriverEnv): Promise<DriverResult> {
    const { ctx, cand } = env;
    const route = cand.route;
    const provider = route.provider;
    const model = route.upstreamModel.replace(/^\/+|\/+$/g, "");

    const prompt: unknown = ctx.form ? getField(ctx.form, "prompt") : ctx.body?.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) throw new DriverClientError(400, "'prompt' is required and must be a non-empty string.", "invalid_request", "prompt");
    const seconds = requestedSeconds(ctx);
    const size = requestedSize(ctx);

    const input: JsonObject = { prompt, duration: String(seconds) };
    if (size) {
      const m = /^(\d{2,5})x(\d{2,5})$/i.exec(size);
      if (!m) throw new DriverClientError(400, "'size' must look like '720x1280'.", "invalid_request", "size");
      input.aspect_ratio = videoAspect(Number(m[1]), Number(m[2]));
    }

    // optional reference image
    const file = ctx.form?.files.find((f) => f.name === "input_reference");
    if (file && ctx.form) {
      if (file.size > MAX_REFERENCE_BYTES) throw new DriverClientError(413, "'input_reference' is too large (max 8 MB).", "payload_too_large", "input_reference");
      const data = await ctx.form.spool.slice(file.start, file.end);
      input.image_url = `data:${file.type || "image/png"};base64,${data.toString("base64")}`;
    } else if (ctx.body) {
      const ref: unknown = ctx.body.input_reference;
      if (typeof ref === "string" && ref.trim()) input.image_url = ref.trim();
      else if (isObject(ref) && typeof ref.image_url === "string") input.image_url = ref.image_url;
    }

    // customer extras, then the admin's overrides
    let extra: unknown = ctx.body?.extra_input;
    if (ctx.form) extra = safeJsonParse<Json>(getField(ctx.form, "extra_input") ?? "");
    if (extra !== undefined && extra !== null) {
      if (!isObject(extra)) throw new DriverClientError(400, "'extra_input' must be an object.", "invalid_request", "extra_input");
      deepMerge(input, extra);
    }
    if (Object.keys(route.paramOverrides).length) deepMerge(input, route.paramOverrides);

    const queueBase = trimSlash(str(provider.settings.queueBaseUrl) ?? "https://queue.fal.run");
    const sub = await falCall(env, { url: `${queueBase}/${model}`, method: "POST", headers: env.headers(true), body: JSON.stringify(input) });
    const requestId = isObject(sub) ? str(sub.request_id) : undefined;
    if (!requestId) throw new DriverFailure("server", 200, "queue submit returned no request_id", JSON.stringify(sub).slice(0, 500));
    const app = model.split("/").slice(0, 2).join("/");
    const idPath = encodeURIComponent(requestId);
    // use fal's own URLs only when they point at the queue origin (the key is sent to them on every poll)
    const pick = (u: unknown, fallback: string) => (typeof u === "string" && sameOrigin(u, queueBase) ? u : fallback);

    return {
      status: 200,
      body: { id: requestId, object: "video", status: "queued", progress: 0, seconds: String(seconds), size, created_at: Math.floor(Date.now() / 1000) },
      usage: emptyUsage(),
      meta: {
        statusUrl: pick(isObject(sub) ? sub.status_url : undefined, `${queueBase}/${app}/requests/${idPath}/status`),
        responseUrl: pick(isObject(sub) ? sub.response_url : undefined, `${queueBase}/${app}/requests/${idPath}`),
        cancelUrl: pick(isObject(sub) ? sub.cancel_url : undefined, `${queueBase}/${app}/requests/${idPath}/cancel`),
      },
    };
  },
};
