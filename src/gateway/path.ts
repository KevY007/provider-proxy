import { GatewayError } from "./errors";
import type { ErrorFormat, InboundFormat, Operation, ParsedPath } from "./types";

interface PostRoute {
  op: Operation;
  format: InboundFormat;
  capability: string;
  multipart?: boolean;
  errorFormat?: ErrorFormat;
}

const POST_ROUTES: Record<string, PostRoute> = {
  "chat/completions": { op: "chat", format: "openai_chat", capability: "chat" },
  completions: { op: "completions", format: "openai_completions", capability: "completions" },
  responses: { op: "responses", format: "openai_responses", capability: "responses" },
  embeddings: { op: "embeddings", format: "openai_embeddings", capability: "embeddings" },
  "images/generations": { op: "images_generations", format: "openai_images", capability: "images" },
  "images/edits": { op: "images_edits", format: "openai_images", capability: "images", multipart: true },
  "images/variations": { op: "images_variations", format: "openai_images", capability: "images", multipart: true },
  "audio/speech": { op: "audio_speech", format: "openai_audio", capability: "audio_speech" },
  "audio/transcriptions": { op: "audio_transcriptions", format: "openai_audio", capability: "audio_transcription", multipart: true },
  "audio/translations": { op: "audio_translations", format: "openai_audio", capability: "audio_transcription", multipart: true },
  moderations: { op: "moderations", format: "openai_moderations", capability: "moderation" },
  messages: { op: "messages", format: "anthropic_messages", capability: "chat", errorFormat: "anthropic" },
  "messages/count_tokens": { op: "messages_count_tokens", format: "anthropic_messages", capability: "chat", errorFormat: "anthropic" },
};

const GEMINI_ACTIONS: Record<string, { op: Operation; stream: boolean; capability: string }> = {
  generateContent: { op: "gemini_generate", stream: false, capability: "chat" },
  streamGenerateContent: { op: "gemini_stream", stream: true, capability: "chat" },
  countTokens: { op: "gemini_count_tokens", stream: false, capability: "chat" },
  embedContent: { op: "gemini_embed", stream: false, capability: "embeddings" },
  batchEmbedContents: { op: "gemini_batch_embed", stream: false, capability: "embeddings" },
};

/** Collapse duplicate slashes / doubled `/v1/v1` prefixes and map Google's OpenAI-compat alias onto `/v1`. */
export function normalizePath(pathname: string): string {
  let p = pathname.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  p = p.replace(/^(\/v1)+(?=\/)/, "/v1"); // /v1/v1/chat/completions -> /v1/chat/completions
  p = p.replace(/^\/v1\/v1beta(?=\/)/, "/v1beta"); // /v1/v1beta/models -> /v1beta/models
  p = p.replace(/^\/v1beta\/openai(?=\/)/, "/v1"); // Google OpenAI-compat alias
  return p;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Parse a request path into format + operation. Throws GatewayError(not_found | method_not_allowed).
 * Pure: no I/O.
 */
export function parsePath(pathname: string, method: string): ParsedPath {
  const m = method.toUpperCase();
  const p = normalizePath(pathname);

  const base = (over: Partial<ParsedPath> & Pick<ParsedPath, "endpoint" | "format" | "op">): ParsedPath => ({
    wireFormat: over.format === "catalog" ? null : (over.format as InboundFormat),
    errorFormat: "openai",
    method: m,
    capability: null,
    pathStream: false,
    multipart: false,
    ...over,
  });

  // ---------------- Gemini surface ----------------
  if (p === "/v1beta/models") {
    if (m !== "GET") throw methodNotAllowed(m, "GET");
    return base({ endpoint: "/v1beta/models", format: "catalog", op: "gemini_models_list", errorFormat: "gemini" });
  }
  if (p.startsWith("/v1beta/models/")) {
    const rest = p.slice("/v1beta/models/".length);
    const colon = rest.lastIndexOf(":");
    if (colon > 0) {
      const model = decode(rest.slice(0, colon));
      const action = rest.slice(colon + 1);
      const def = GEMINI_ACTIONS[action];
      if (!def) throw new GatewayError("not_found", `Unknown Gemini method: ${action}`);
      if (m !== "POST") throw methodNotAllowed(m, "POST");
      return base({
        endpoint: `/v1beta/models:${action}`,
        format: "gemini",
        op: def.op,
        errorFormat: "gemini",
        capability: def.capability,
        model,
        pathStream: def.stream,
      });
    }
    if (m !== "GET") throw methodNotAllowed(m, "GET");
    return base({ endpoint: "/v1beta/models/{model}", format: "catalog", op: "gemini_model_get", errorFormat: "gemini", model: decode(rest) });
  }

  // ---------------- OpenAI / Anthropic surface ----------------
  if (p === "/v1/models") {
    if (m !== "GET") throw methodNotAllowed(m, "GET");
    return base({ endpoint: "/v1/models", format: "catalog", op: "models_list" });
  }
  if (p === "/v1/model/info" || p === "/v1/model_info") {
    // LiteLLM-compatible price / capability sheet at the caller's effective price
    if (m !== "GET") throw methodNotAllowed(m, "GET");
    return base({ endpoint: "/v1/model/info", format: "catalog", op: "model_info" });
  }
  if (p.startsWith("/v1/models/")) {
    if (m !== "GET") throw methodNotAllowed(m, "GET");
    return base({ endpoint: "/v1/models/{model}", format: "catalog", op: "model_get", model: decode(p.slice("/v1/models/".length)) });
  }

  if (p.startsWith("/v1/responses/")) {
    const parts = p.slice("/v1/responses/".length).split("/");
    const id = decode(parts[0] ?? "");
    const sub = parts[1];
    if (!id || parts.length > 2) throw new GatewayError("not_found");
    const r = (op: Operation, endpoint: string, allowed: string): ParsedPath => {
      if (m !== allowed) throw methodNotAllowed(m, allowed);
      return base({ endpoint, format: "openai_responses", op, capability: "responses", responseId: id });
    };
    if (!sub) {
      if (m === "DELETE") return r("responses_delete", "/v1/responses/{id}", "DELETE");
      return r("responses_get", "/v1/responses/{id}", "GET");
    }
    if (sub === "cancel") return r("responses_cancel", "/v1/responses/{id}/cancel", "POST");
    if (sub === "input_items") return r("responses_input_items", "/v1/responses/{id}/input_items", "GET");
    throw new GatewayError("not_found");
  }

  // ---------------- Videos (OpenAI Sora-compatible): create / list / get / content / delete ----------------
  if (p === "/v1/videos") {
    if (m === "POST") return base({ endpoint: "/v1/videos", format: "openai_videos", op: "videos_create", capability: "video" });
    if (m === "GET") return base({ endpoint: "/v1/videos", format: "openai_videos", op: "videos_list" });
    throw methodNotAllowed(m, "GET, POST");
  }
  if (p.startsWith("/v1/videos/")) {
    const parts = p.slice("/v1/videos/".length).split("/");
    const id = decode(parts[0] ?? "");
    const sub = parts[1];
    if (!id || parts.length > 2) throw new GatewayError("not_found");
    const v = (op: Operation, endpoint: string, allowed: string): ParsedPath => {
      if (m !== allowed) throw methodNotAllowed(m, allowed);
      return base({ endpoint, format: "openai_videos", op, videoId: id });
    };
    if (!sub) return m === "DELETE" ? v("videos_delete", "/v1/videos/{id}", "DELETE") : v("videos_get", "/v1/videos/{id}", "GET");
    if (sub === "content") return v("videos_content", "/v1/videos/{id}/content", "GET");
    throw new GatewayError("not_found", "Unknown endpoint. See the API reference for supported paths.");
  }

  if (p.startsWith("/v1/")) {
    const key = p.slice("/v1/".length);
    const def = POST_ROUTES[key];
    if (def) {
      if (m !== "POST") throw methodNotAllowed(m, "POST");
      return base({
        endpoint: `/v1/${key}`,
        format: def.format,
        op: def.op,
        errorFormat: def.errorFormat ?? "openai",
        capability: def.capability,
        multipart: def.multipart ?? false,
      });
    }
  }

  throw new GatewayError("not_found", "Unknown endpoint. See the API reference for supported paths.");
}

function methodNotAllowed(got: string, allowed: string): GatewayError {
  return new GatewayError("method_not_allowed", `Method ${got} is not allowed for this endpoint (use ${allowed}).`, {
    headers: { allow: allowed },
  });
}

/** Best-effort error format when the path could not be parsed (so even 404s match the client's SDK). */
export function guessErrorFormat(pathname: string): ErrorFormat {
  const p = normalizePath(pathname);
  if (p.startsWith("/v1beta/models")) return "gemini";
  if (p.startsWith("/v1/messages")) return "anthropic";
  return "openai";
}
