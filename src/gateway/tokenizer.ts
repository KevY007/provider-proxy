import { isObject } from "./util";
import type { Json } from "./types";

/**
 * Token estimation. Two tiers:
 *  - `roughTokens` / `estimateInputTokens`: cheap synchronous char heuristics for pre-flight balance checks.
 *  - `countTokens`: js-tiktoken o200k_base (lazy loaded) for the usage fallback when an upstream returns no usage.
 */
const IMAGE_TOKENS = 1000;
/** Encoded documents (PDF ...) of unknown token count: estimated per base64 character (generous, so holds do not undershoot). */
const DOC_CHARS_PER_TOKEN = 8;
/** A referenced file (`file_id`, file URL / URI) whose size we do not know. */
const FILE_REF_TOKENS = 25_000;

export function roughTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

function looksLikeBlob(s: string): boolean {
  if (s.startsWith("data:")) return true;
  if (s.length < 2000) return false;
  return /^[A-Za-z0-9+/=\r\n]{200}/.test(s);
}

const isImageMime = (m: unknown): boolean => typeof m === "string" && /^image\//i.test(m);

/**
 * Collect the human text of a request body (any inbound format), an image count, and `extraTokens` for content that is
 * not plain text: encoded documents (base64 PDFs, data: URIs that are not images) and referenced files of unknown size.
 * Text is always counted, also when it happens to look like base64 (a hold must never undershoot on crafted input).
 */
export function collectText(body: Json): { text: string; images: number; messages: number; extraTokens: number } {
  const parts: string[] = [];
  let images = 0;
  let messages = 0;
  let extra = 0;
  const encoded = (s: string) => (extra += Math.ceil(s.length / DOC_CHARS_PER_TOKEN));
  /** a media payload object: Anthropic `source`, Gemini `inlineData` / `fileData`, OpenAI `image_url` / `file` */
  const media = (x: Json, imageBlock: boolean): void => {
    if (!isObject(x)) return;
    if (x.type === "text" && typeof x.data === "string") return void parts.push(x.data); // Anthropic plain-text document
    if (x.type === "content") return visit(x.content, "content", 1);
    const data = typeof x.data === "string" ? x.data : typeof x.file_data === "string" ? x.file_data : null;
    const mime = x.media_type ?? x.mimeType ?? x.mime_type;
    if (data) return void (imageBlock || isImageMime(mime) || data.startsWith("data:image") ? images++ : encoded(data));
    if (typeof x.url === "string" && !imageBlock && !/^data:image/i.test(x.url)) {
      if (x.url.startsWith("data:")) encoded(x.url);
      else extra += FILE_REF_TOKENS;
      return;
    }
    if (x.file_id || x.fileUri || x.file_uri || x.type === "file") {
      if (imageBlock || isImageMime(mime)) images++;
      else extra += FILE_REF_TOKENS;
      return;
    }
    if (imageBlock || typeof x.url === "string") images++;
  };
  const visit = (v: unknown, key: string | null, depth: number): void => {
    if (depth > 30) return;
    if (typeof v === "string") {
      if (key === "role" || key === "type" || key === "model" || key === "id" || key === "tool_call_id" || key === "tool_use_id") return;
      if (v.startsWith("data:")) {
        if (v.startsWith("data:image")) images++;
        else encoded(v);
        return;
      }
      if (key === "file_id" && v.length < 256) {
        extra += FILE_REF_TOKENS;
        return;
      }
      parts.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
    } else if (isObject(v)) {
      if (key === "messages" || key === "contents") messages++;
      const imageBlock = v.type === "image" || v.type === "image_url" || v.type === "input_image";
      for (const [k, x] of Object.entries(v)) {
        if ((k === "inlineData" || k === "inline_data" || k === "fileData" || k === "file_data" || k === "source" || k === "image_url" || (k === "file" && isObject(x))) && isObject(x)) {
          media(x, imageBlock || k === "image_url");
          continue;
        }
        if (imageBlock && typeof x === "string" && (k === "image_url" || looksLikeBlob(x))) {
          images++; // OpenAI Responses `input_image.image_url` as a string
          continue;
        }
        visit(x, k, depth + 1);
      }
    }
  };
  visit(body, null, 0);
  if (Array.isArray(body?.messages)) messages = body.messages.length;
  else if (Array.isArray(body?.contents)) messages = body.contents.length;
  return { text: parts.join("\n"), images, messages, extraTokens: extra };
}

/** Cheap input-token estimate for the balance pre-check. */
export function estimateInputTokens(body: Json): number {
  const { text, images, messages, extraTokens } = collectText(body);
  return roughTokens(text) + images * IMAGE_TOKENS + messages * 4 + extraTokens;
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
