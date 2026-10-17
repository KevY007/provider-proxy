import { handle } from "@/gateway/handle";

/**
 * Gemini resumable-upload surface: POST /upload/v1beta/files (start / one-shot / data phase). Same gateway, same
 * pipeline: the request body is streamed to the upstream untouched (uploads of any size).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 800;

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const DELETE = handle;
export const OPTIONS = handle;
