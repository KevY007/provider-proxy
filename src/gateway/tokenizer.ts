import { isObject } from "./util";
import type { Json } from "./types";

/**
 * Token estimation. Two tiers:
 *  - `roughTokens` / `estimateInputTokens`: cheap synchronous char heuristics for pre-flight balance checks.
 *  - `countTokens`: js-tiktoken o200k_base (lazy loaded) for the usage fallback when an upstream returns no usage.
 */
const IMAGE_TOKENS = 1000;

export function roughTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

function looksLikeBlob(s: string): boolean {
  if (s.startsWith("data:")) return true;
  if (s.length < 2000) return false;
  return /^[A-Za-z0-9+/=\r\n]{200}/.test(s);
}

/** Collect the human text of a request body (any inbound format) and an image count. */
export function collectText(body: Json): { text: string; images: number; messages: number } {
  const parts: string[] = [];
  let images = 0;
  let messages = 0;
  const visit = (v: unknown, key: string | null, depth: number): void => {
    if (depth > 30) return;
    if (typeof v === "string") {
      if (key === "role" || key === "type" || key === "model" || key === "id" || key === "tool_call_id" || key === "tool_use_id") return;
      if (looksLikeBlob(v)) {
        images++;
        return;
      }
      parts.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
    } else if (isObject(v)) {
      if (key === "messages" || key === "contents") messages++;
      if (v.type === "image" || v.type === "image_url" || v.type === "input_image" || v.inlineData || v.inline_data) images++;
      for (const [k, x] of Object.entries(v)) {
        if (k === "inlineData" || k === "inline_data" || k === "source" || k === "image_url") {
          // image payloads: counted above, skip contents
          if (typeof x === "object" && x !== null) continue;
        }
        visit(x, k, depth + 1);
      }
    }
  };
  visit(body, null, 0);
  if (Array.isArray(body?.messages)) messages = body.messages.length;
  else if (Array.isArray(body?.contents)) messages = body.contents.length;
  return { text: parts.join("\n"), images, messages };
}

/** Cheap input-token estimate for the balance pre-check. */
export function estimateInputTokens(body: Json): number {
  const { text, images, messages } = collectText(body);
  return roughTokens(text) + images * IMAGE_TOKENS + messages * 4;
}

type Enc = { encode(text: string): number[] };
let encPromise: Promise<Enc | null> | null = null;

async function getEncoder(): Promise<Enc | null> {
  if (!encPromise) {
    encPromise = (async () => {
      try {
        const { Tiktoken } = await import("js-tiktoken/lite");
        const ranks = (await import("js-tiktoken/ranks/o200k_base")).default;
        return new Tiktoken(ranks) as Enc;
      } catch {
        return null;
      }
    })();
  }
  return encPromise;
}

/** Warm the encoder in the background (call once at startup / first stream). */
export function warmTokenizer(): void {
  void getEncoder();
}

/** Token count via tiktoken when available; heuristic fallback for huge strings or load failures. */
export async function countTokens(text: string): Promise<number> {
  if (!text) return 0;
  if (text.length > 400_000) return roughTokens(text);
  const enc = await getEncoder();
  if (!enc) return roughTokens(text);
  try {
    return enc.encode(text).length;
  } catch {
    return roughTokens(text);
  }
}

/** Accurate-ish prompt token count for a request body (usage fallback). */
export async function countRequestTokens(body: Json): Promise<number> {
  const { text, images, messages } = collectText(body);
  return (await countTokens(text)) + images * IMAGE_TOKENS + messages * 4;
}
