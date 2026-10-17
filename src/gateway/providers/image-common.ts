import type { Json, JsonObject } from "../types";
import { emptyUsage, type Usage } from "../types";
import { deepMerge, isObject } from "../util";
import { DriverClientError, DriverFailure, type DriverEnv } from "./driver-types";

/**
 * Shared helpers of the image drivers (fal.ai, Replicate): OpenAI `images/generations` request parsing and the
 * OpenAI-shaped response (`{created, data:[{url|b64_json}]}`).
 */
export type ImageResponseFormat = "url" | "b64_json";

export interface ImageRequest {
  prompt: string;
  n: number;
  size: { w: number; h: number } | null;
  seed: number | null;
  format: ImageResponseFormat;
  outputFormat: "png" | "jpeg" | "webp" | null;
  extraInput: JsonObject | null;
  negativePrompt: string | null;
}

const MAX_N = 10;

/** Parse + validate the OpenAI images/generations body. Throws DriverClientError (customer-safe messages). */
export function parseImageRequest(body: JsonObject | null): ImageRequest {
  const b = body ?? {};
  if (typeof b.prompt !== "string" || !b.prompt.trim()) throw new DriverClientError(400, "'prompt' is required and must be a non-empty string.", "invalid_request", "prompt");

  let n = 1;
  if (b.n !== undefined && b.n !== null) {
    if (typeof b.n !== "number" || !Number.isInteger(b.n) || b.n < 1 || b.n > MAX_N) throw new DriverClientError(400, `'n' must be an integer between 1 and ${MAX_N}.`, "invalid_request", "n");
    n = b.n;
  }

  let size: ImageRequest["size"] = null;
  if (b.size !== undefined && b.size !== null && b.size !== "auto") {
    const m = typeof b.size === "string" ? /^(\d{2,5})x(\d{2,5})$/i.exec(b.size.trim()) : null;
    if (!m) throw new DriverClientError(400, "'size' must look like '1024x1024'.", "invalid_request", "size");
    size = { w: Number(m[1]), h: Number(m[2]) };
  }

  let seed: number | null = null;
  if (b.seed !== undefined && b.seed !== null) {
    if (typeof b.seed !== "number" || !Number.isFinite(b.seed)) throw new DriverClientError(400, "'seed' must be a number.", "invalid_request", "seed");
    seed = Math.trunc(b.seed);
  }

  let format: ImageResponseFormat = "url";
  if (b.response_format !== undefined && b.response_format !== null) {
    if (b.response_format !== "url" && b.response_format !== "b64_json") throw new DriverClientError(400, "'response_format' must be 'url' or 'b64_json'.", "invalid_request", "response_format");
    format = b.response_format;
  }

  let outputFormat: ImageRequest["outputFormat"] = null;
  if (typeof b.output_format === "string") {
    const f = b.output_format.toLowerCase();
    if (f === "png" || f === "jpeg" || f === "webp") outputFormat = f;
    else if (f === "jpg") outputFormat = "jpeg";
    else throw new DriverClientError(400, "'output_format' must be 'png', 'jpeg' or 'webp'.", "invalid_request", "output_format");
  }

  let extraInput: JsonObject | null = null;
  if (b.extra_input !== undefined && b.extra_input !== null) {
    if (!isObject(b.extra_input)) throw new DriverClientError(400, "'extra_input' must be an object.", "invalid_request", "extra_input");
    extraInput = b.extra_input;
  }

  const negativePrompt = typeof b.negative_prompt === "string" && b.negative_prompt.trim() ? b.negative_prompt : null;
  return { prompt: b.prompt, n, size, seed, format, outputFormat, extraInput, negativePrompt };
}

/** Customer extras first, then the admin's route.paramOverrides (which always win; `null` deletes a field). */
export function finishInput(input: JsonObject, req: ImageRequest, paramOverrides: JsonObject): JsonObject {
  if (req.extraInput) deepMerge(input, req.extraInput);
  if (Object.keys(paramOverrides).length) deepMerge(input, paramOverrides);
  return input;
}

const ASPECTS: Array<[string, number]> = [
  ["1:1", 1],
  ["16:9", 16 / 9],
  ["9:16", 9 / 16],
  ["4:3", 4 / 3],
  ["3:4", 3 / 4],
  ["3:2", 3 / 2],
  ["2:3", 2 / 3],
  ["5:4", 5 / 4],
  ["4:5", 4 / 5],
  ["21:9", 21 / 9],
  ["9:21", 9 / 21],
];

/** Closest standard aspect-ratio string ("16:9") for a WxH size (Replicate `aspect_ratio`). */
export function nearestAspectRatio(w: number, h: number): string {
  const r = w / h;
  let best = ASPECTS[0];
  let bestD = Infinity;
  for (const a of ASPECTS) {
    const d = Math.abs(Math.log(r / a[1]));
    if (d < bestD) {
      bestD = d;
      best = a;
    }
  }
  return best[0];
}

/** fal `image_size`: the named presets where they match exactly, else an explicit {width,height}. */
export function falImageSize(size: { w: number; h: number }): string | { width: number; height: number } {
  const key = `${size.w}x${size.h}`;
  const named: Record<string, string> = {
    "1024x1024": "square_hd",
    "512x512": "square",
    "768x1024": "portrait_4_3",
    "576x1024": "portrait_16_9",
    "1024x768": "landscape_4_3",
    "1024x576": "landscape_16_9",
  };
  return named[key] ?? { width: size.w, height: size.h };
}

/** Turn result URLs into OpenAI `data[]` entries (downloading + base64-encoding when `b64_json` was requested). */
export async function toImageData(env: DriverEnv, urls: string[], format: ImageResponseFormat): Promise<Json[]> {
  if (format === "url") return urls.map((url) => ({ url }));
  return Promise.all(
    urls.map(async (url) => {
      if (url.startsWith("data:")) {
        const comma = url.indexOf(",");
        if (comma > 0 && /;base64/i.test(url.slice(0, comma))) return { b64_json: url.slice(comma + 1) };
      }
      const { data } = await env.download(url);
      return { b64_json: data.toString("base64") };
    }),
  );
}

export function imageResult(data: Json[]): { status: number; body: Json; usage: Usage } {
  if (!data.length) throw new DriverFailure("server", 200, "the upstream returned no images");
  const usage = emptyUsage();
  usage.imageCount = data.length;
  return { status: 200, body: { created: Math.floor(Date.now() / 1000), data }, usage };
}

export const trimSlash = (s: string): string => s.replace(/\/+$/, "");
export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Poll delay: 400ms, growing 1.5x per attempt up to 2.5s. */
export const pollDelay = (attempt: number): number => Math.min(2500, Math.round(400 * Math.pow(1.5, attempt)));
