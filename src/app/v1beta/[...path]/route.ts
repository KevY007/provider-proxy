import { handle } from "@/gateway/handle";

/** Gemini surface: /v1beta/models, /v1beta/models/{model}:generateContent | :streamGenerateContent | :countTokens | :embedContent | :batchEmbedContents */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
export const OPTIONS = handle;
