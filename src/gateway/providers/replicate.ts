import type { Json, JsonObject } from "../types";
import { ClientAbortError } from "../upstream";
import { isObject } from "../util";
import { DriverClientError, DriverFailure, type Driver, type DriverEnv, type DriverResult } from "./driver-types";
import { finishInput, imageResult, nearestAspectRatio, parseImageRequest, pollDelay, toImageData, trimSlash } from "./image-common";

/**
 * Replicate image driver (`openai_images` -> POST /v1/images/generations).
 *
 *   owner/name           POST {base}/models/{owner}/{name}/predictions     {input}
 *   owner/name:version   POST {base}/predictions                           {version, input}   (also a bare 64-hex version id)
 *   Prefer: wait=N       optional (Provider.settings.replicateWait = seconds, 1-60): the create call then blocks for up to N
 *                        seconds and answers with the finished prediction. OFF by default: measured against the live API it
 *                        holds the connection for the full N seconds even when the prediction finished after ~5s, which is
 *                        slower than polling.
 *   polling              GET {base}/predictions/{id} (backoff 0.4s -> 2.5s) until succeeded | failed | canceled.
 */
const TERMINAL = new Set(["succeeded", "failed", "canceled"]);

function endpoint(model: string, base: string): { url: string; version: string | null } {
  const pinned = /^([^/:\s]+\/[^/:\s]+):([A-Za-z0-9]+)$/.exec(model);
  if (pinned) return { url: `${base}/predictions`, version: pinned[2] };
  if (/^[a-f0-9]{64}$/.test(model)) return { url: `${base}/predictions`, version: model };
  if (!/^[^/\s]+\/[^/\s]+$/.test(model)) throw new DriverClientError(400, "This model is not configured correctly.", "invalid_request");
  return { url: `${base}/models/${model}/predictions`, version: null };
}

function buildInput(env: DriverEnv): { input: JsonObject; format: "url" | "b64_json" } {
  const req = parseImageRequest(env.ctx.body);
  const input: JsonObject = { prompt: req.prompt };
  if (req.negativePrompt) input.negative_prompt = req.negativePrompt;
  if (req.size) input.aspect_ratio = nearestAspectRatio(req.size.w, req.size.h);
  if (req.n > 1) input.num_outputs = req.n;
  if (req.seed !== null) input.seed = req.seed;
  if (req.outputFormat) input.output_format = req.outputFormat === "jpeg" ? "jpg" : req.outputFormat;
  finishInput(input, req, env.cand.route.paramOverrides);
  return { input, format: req.format };
}

function outputUrls(output: Json): string[] {
  if (typeof output === "string") return [output];
  if (Array.isArray(output)) return output.flatMap(outputUrls);
  if (isObject(output)) {
    if (typeof output.url === "string") return [output.url];
    for (const k of ["images", "image", "output"]) if (output[k] !== undefined) return outputUrls(output[k]);
  }
  return [];
}

export const replicateImagesDriver: Driver = {
  name: "replicate.images",
  async run(env: DriverEnv): Promise<DriverResult> {
    const provider = env.cand.route.provider;
    const base = trimSlash(provider.baseUrl);
    const target = endpoint(env.cand.route.upstreamModel, base);
    const { input, format } = buildInput(env);

    const configured = Number(provider.settings.replicateWait);
    const waitSec = Number.isFinite(configured) && configured > 0 ? Math.max(1, Math.min(60, Math.floor(configured), Math.floor((env.deadline - Date.now()) / 1000))) : 0;
    const payload = target.version ? { version: target.version, input } : { input };
    const headers = env.headers(true);
    if (waitSec) headers.prefer = `wait=${waitSec}`;
    let pred = await env.json({ url: target.url, method: "POST", headers, body: JSON.stringify(payload) });
    if (!isObject(pred) || typeof pred.id !== "string") throw new DriverFailure("server", 200, "unexpected prediction response", JSON.stringify(pred).slice(0, 500));
    const id = pred.id;
    const getUrl = `${base}/predictions/${encodeURIComponent(id)}`;

    try {
      for (let i = 0; !TERMINAL.has(String((pred as JsonObject).status)); i++) {
        await env.sleep(pollDelay(i));
        pred = await env.json({ url: getUrl, method: "GET", headers: env.headers(false) });
        if (!isObject(pred)) throw new DriverFailure("server", 200, "unexpected prediction response");
      }
    } catch (e) {
      if (e instanceof ClientAbortError || (e instanceof DriverFailure && e.fk === "timeout")) {
        // stop paying for a prediction nobody waits for (best effort)
        env.request({ url: `${getUrl}/cancel`, method: "POST", headers: env.headers(false), timeoutMs: 5000 }).catch(() => undefined);
      }
      throw e;
    }

    const p = pred as JsonObject;
    if (p.status !== "succeeded") {
      const err = typeof p.error === "string" ? p.error : String(p.status);
      if (/nsfw|safety|content policy|sensitive|violat/i.test(err)) {
        throw new DriverClientError(400, "The request was rejected by the content safety filter.", "invalid_request", undefined, { internal: `prediction ${String(p.status)}: ${err.slice(0, 500)}` });
      }
      // the model itself failed: deterministic, retrying on another key would only pay for it again
      throw new DriverClientError(502, "The upstream provider returned an error.", "upstream_error", undefined, { kind: "upstream", internal: `prediction ${String(p.status)}: ${err.slice(0, 500)}` });
    }
    const urls = outputUrls(p.output);
    if (!urls.length) throw new DriverFailure("server", 200, "Replicate returned no images", JSON.stringify(p.output).slice(0, 300));
    return imageResult(await toImageData(env, urls, format));
  },
};
