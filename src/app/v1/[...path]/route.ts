import { handle } from "@/gateway/handle";

/**
 * OpenAI + Anthropic surface: /v1/chat/completions, /v1/messages, /v1/responses, /v1/embeddings, /v1/images/*,
 * /v1/audio/*, /v1/moderations, /v1/models ... (doubled `/v1/v1` prefixes are normalised by the gateway).
 * All logic lives in src/gateway (framework agnostic `handle(Request) => Response`).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
