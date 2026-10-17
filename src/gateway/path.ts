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
export function parsePath(pathname: string, method: string, headers?: Headers): ParsedPath {
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

  // ---------------- Files APIs (raw passthrough, PLAN 5c) ----------------
  const raw = (over: Partial<ParsedPath> & Pick<ParsedPath, "endpoint" | "format" | "op">): ParsedPath => base({ raw: true, ...over });

  // Gemini: resumable upload (/upload/v1beta/files) + file resources (/v1beta/files)
  if (p === "/upload/v1beta/files") {
    if (m !== "POST" && m !== "PUT") throw methodNotAllowed(m, "POST");
    return raw({ endpoint: "/upload/v1beta/files", format: "gemini_files", op: "gfiles_upload", errorFormat: "gemini" });
  }
  if (p === "/v1beta/files") {
    if (m !== "GET") throw methodNotAllowed(m, "GET");
    return raw({ endpoint: "/v1beta/files", format: "gemini_files", op: "gfiles_list", errorFormat: "gemini" });
  }
  if (p.startsWith("/v1beta/files/")) {
    const id = decode(p.slice("/v1beta/files/".length));
    if (!id || id.includes("/")) throw new GatewayError("not_found");
    if (m === "GET") return raw({ endpoint: "/v1beta/files/{id}", format: "gemini_files", op: "gfiles_get", errorFormat: "gemini", objectId: `files/${id}` });
    if (m === "DELETE") return raw({ endpoint: "/v1beta/files/{id}", format: "gemini_files", op: "gfiles_delete", errorFormat: "gemini", objectId: `files/${id}` });
    throw methodNotAllowed(m, "GET, DELETE");
  }

  // OpenAI + Anthropic: /v1/files (the Anthropic Files API is told apart by its anthropic-version header)
  if (p === "/v1/files" || p.startsWith("/v1/files/")) {
    const anthropic = !!headers?.get("anthropic-version");
    const format = anthropic ? ("anthropic_files" as const) : ("openai_files" as const);
    const errorFormat: ErrorFormat = anthropic ? "anthropic" : "openai";
    if (p === "/v1/files") {
      if (m === "POST") return raw({ endpoint: "/v1/files", format, op: "files_create", errorFormat });
      if (m === "GET") return raw({ endpoint: "/v1/files", format, op: "files_list", errorFormat });
      throw methodNotAllowed(m, "GET, POST");
    }
    const parts = p.slice("/v1/files/".length).split("/");
    const id = decode(parts[0] ?? "");
    if (!id || parts.length > 2) throw new GatewayError("not_found");
    if (parts.length === 2) {
      if (parts[1] !== "content") throw new GatewayError("not_found");
      if (m !== "GET") throw methodNotAllowed(m, "GET");
      return raw({ endpoint: "/v1/files/{id}/content", format, op: "files_content", errorFormat, objectId: id });
    }
    if (m === "GET") return raw({ endpoint: "/v1/files/{id}", format, op: "files_get", errorFormat, objectId: id });
    if (m === "DELETE") return raw({ endpoint: "/v1/files/{id}", format, op: "files_delete", errorFormat, objectId: id });
    throw methodNotAllowed(m, "GET, DELETE");
  }
  // OpenAI code-interpreter container files (files a Responses request created): metadata + content, owner-checked
  if (p.startsWith("/v1/containers/")) {
    const parts = p.slice("/v1/containers/".length).split("/");
    const cid = decode(parts[0] ?? "");
    const fid = decode(parts[2] ?? "");
    if (!cid || parts[1] !== "files" || !fid || parts.length > 4 || (parts.length === 4 && parts[3] !== "content")) throw new GatewayError("not_found");
    if (m !== "GET") throw methodNotAllowed(m, "GET");
    return raw({
      endpoint: parts.length === 4 ? "/v1/containers/{id}/files/{file}/content" : "/v1/containers/{id}/files/{file}",
      format: "openai_files",
      op: parts.length === 4 ? "containers_file_content" : "containers_file_get",
      objectId: `${cid}/${fid}`,
    });
  }
  // OpenAI multipart uploads (files larger than a single request): create -> parts -> complete | cancel
  if (p === "/v1/uploads" || p.startsWith("/v1/uploads/")) {
    if (p === "/v1/uploads") {
      if (m !== "POST") throw methodNotAllowed(m, "POST");
      return raw({ endpoint: "/v1/uploads", format: "openai_files", op: "uploads_create" });
    }
    const parts = p.slice("/v1/uploads/".length).split("/");
    const id = decode(parts[0] ?? "");
    const sub = parts[1];
    if (!id || parts.length !== 2) throw new GatewayError("not_found");
    if (m !== "POST") throw methodNotAllowed(m, "POST");
    if (sub === "parts") return raw({ endpoint: "/v1/uploads/{id}/parts", format: "openai_files", op: "uploads_part", objectId: id });
    if (sub === "complete") return raw({ endpoint: "/v1/uploads/{id}/complete", format: "openai_files", op: "uploads_complete", objectId: id });
    if (sub === "cancel") return raw({ endpoint: "/v1/uploads/{id}/cancel", format: "openai_files", op: "uploads_cancel", objectId: id });
    throw new GatewayError("not_found");
  }

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
export function guessErrorFormat(pathname: string, headers?: Headers): ErrorFormat {
  const p = normalizePath(pathname);
  if (p.startsWith("/v1beta/") || p.startsWith("/upload/v1beta/")) return "gemini";
  if (p.startsWith("/v1/messages")) return "anthropic";
  if (p.startsWith("/v1/files") && headers?.get("anthropic-version")) return "anthropic";
  return "openai";
}
