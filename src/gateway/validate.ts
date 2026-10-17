import type { Ctx } from "./context";
import { GatewayError } from "./errors";
import { getField } from "./multipart";
import type { JsonObject } from "./types";
import { isObject } from "./util";

/**
 * Lightweight request validation, run before anything is reserved or sent upstream (QA finding #3): the obvious
 * "required field missing / wrong type" mistakes are answered with a clear 400 `invalid_request` in the inbound
 * format's native error shape instead of an opaque upstream error (or, worse, a billed round trip).
 * Deliberately shallow: provider-specific semantics are left to the upstream.
 */
const fail = (message: string, param?: string): never => {
  throw new GatewayError("invalid_request", message, { param: param ?? null });
};

const isPosInt = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 1;
const blank = (v: unknown): boolean => v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);

function requireNonEmptyArray(b: JsonObject, field: string): void {
  const v = b[field];
  if (v === undefined || v === null) fail(`'${field}' is required.`, field);
  if (!Array.isArray(v)) fail(`'${field}' must be an array.`, field);
  if ((v as unknown[]).length === 0) fail(`'${field}' must be a non-empty array.`, field);
}

function requireObjectItems(b: JsonObject, field: string): void {
  (b[field] as unknown[]).forEach((m, i) => {
    if (!isObject(m)) fail(`'${field}[${i}]' must be an object.`, `${field}[${i}]`);
  });
}

function optionalPosInt(b: JsonObject, field: string, max?: number): void {
  const v = b[field];
  if (v === undefined || v === null) return;
  if (!isPosInt(v)) fail(`'${field}' must be a positive integer.`, field);
  if (max !== undefined && (v as number) > max) fail(`'${field}' must be at most ${max}.`, field);
}

export function validateRequest(ctx: Ctx): void {
  const path = ctx.path!;
  const op = path.op;
  const b: JsonObject = ctx.body ?? {};

  switch (op) {
    case "chat":
      requireNonEmptyArray(b, "messages");
      requireObjectItems(b, "messages");
      optionalPosInt(b, "max_tokens");
      optionalPosInt(b, "max_completion_tokens");
      optionalPosInt(b, "n", 128);
      return;
    case "completions":
      if (b.prompt === undefined || b.prompt === null) fail("'prompt' is required.", "prompt");
      optionalPosInt(b, "max_tokens");
      optionalPosInt(b, "n", 128);
      return;
    case "responses":
      if ((b.input === undefined || b.input === null) && (b.prompt === undefined || b.prompt === null)) fail("'input' is required.", "input");
      if (b.input !== undefined && b.input !== null && blank(b.input)) fail("'input' must not be empty.", "input");
      optionalPosInt(b, "max_output_tokens");
      return;
    case "messages":
      requireNonEmptyArray(b, "messages");
      requireObjectItems(b, "messages");
      optionalPosInt(b, "max_tokens"); // omitted: filled in by the funds guard (the Anthropic API itself requires it)
      return;
    case "messages_count_tokens":
      requireNonEmptyArray(b, "messages");
      requireObjectItems(b, "messages");
      return;
    case "embeddings":
      if (blank(b.input)) fail("'input' is required and must not be empty.", "input");
      return;
    case "moderations":
      if (blank(b.input)) fail("'input' is required and must not be empty.", "input");
      return;
    case "images_generations":
      if (typeof b.prompt !== "string" || !b.prompt.trim()) fail("'prompt' is required and must be a non-empty string.", "prompt");
      if (b.n !== undefined && b.n !== null && (!isPosInt(b.n) || (b.n as number) > 10)) fail("'n' must be an integer between 1 and 10.", "n");
      return;
    case "images_edits": {
      const form = ctx.form;
      if (!form) return;
      if (!form.files.some((f) => f.name === "image" || f.name === "image[]")) fail("An 'image' file is required.", "image");
      if (!(getField(form, "prompt") ?? "").trim()) fail("'prompt' is required.", "prompt");
      return;
    }
    case "images_variations": {
      const form = ctx.form;
      if (form && !form.files.some((f) => f.name === "image")) fail("An 'image' file is required.", "image");
      return;
    }
    case "audio_speech":
      if (typeof b.input !== "string" || !b.input.trim()) fail("'input' is required and must be a non-empty string.", "input");
      return;
    case "audio_transcriptions":
    case "audio_translations": {
      const form = ctx.form;
      if (form && !form.files.some((f) => f.name === "file")) fail("A 'file' to transcribe is required.", "file");
      return;
    }
    case "videos_create": {
      const prompt = ctx.form ? getField(ctx.form, "prompt") : b.prompt;
      if (typeof prompt !== "string" || !prompt.trim()) fail("'prompt' is required and must be a non-empty string.", "prompt");
      return;
    }
    case "gemini_generate":
    case "gemini_stream": {
      requireNonEmptyArray(b, "contents");
      const gc = isObject(b.generationConfig) ? b.generationConfig : isObject(b.generation_config) ? b.generation_config : null;
      if (gc) {
        for (const f of ["maxOutputTokens", "max_output_tokens"]) {
          const v = gc[f];
          if (v !== undefined && v !== null && !isPosInt(v)) fail(`'generationConfig.${f}' must be a positive integer.`, `generationConfig.${f}`);
        }
      }
      return;
    }
    case "gemini_count_tokens":
      if (!Array.isArray(b.contents) && !isObject(b.generateContentRequest) && !isObject(b.generate_content_request)) fail("'contents' is required.", "contents");
      return;
    case "gemini_embed":
      if (!isObject(b.content)) fail("'content' is required.", "content");
      return;
    case "gemini_batch_embed":
      requireNonEmptyArray(b, "requests");
      return;
    default:
      return;
  }
}
