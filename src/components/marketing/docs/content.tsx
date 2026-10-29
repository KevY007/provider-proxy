import type { ReactNode } from "react";
import * as A from "./content-a";
import * as B from "./content-b";
import type { DocCtx } from "./content-a";

export type { DocCtx };

/** Slug -> renderer. Slugs must match `registry.ts`. */
const RENDER: Record<string, (ctx: DocCtx) => ReactNode> = {
  "": A.quickstart,
  authentication: A.authentication,
  "openai/chat-completions": A.openaiChat,
  "openai/responses": A.openaiResponses,
  "openai/completions": A.openaiCompletions,
  "openai/embeddings": A.openaiEmbeddings,
  "openai/images": A.openaiImages,
  "openai/audio": A.openaiAudio,
  "openai/moderations": A.openaiModerations,
  "openai/models": A.openaiModels,
  "anthropic/messages": A.anthropicMessages,
  "anthropic/count-tokens": A.anthropicCountTokens,
  "anthropic/headers": () => A.anthropicHeaders(),
  gemini: A.gemini,
  streaming: B.streaming,
  tools: B.tools,
  images: B.imagesGuide,
  "openai/videos": B.videosGuide,
  batches: B.batchesGuide,
  "rate-limits": () => B.rateLimits(),
  billing: (ctx) => B.billing(ctx),
  "pricing-api": B.pricingApi,
  errors: () => B.errors(),
  "clients/codex-cli": B.codexCli,
  "clients/claude-code": B.claudeCode,
  "clients/opencode": B.opencode,
  "clients/cursor": B.cursor,
  "clients/python": B.pythonClient,
  "clients/node": B.nodeClient,
};

export function renderDoc(slug: string, ctx: DocCtx): ReactNode | null {
  const r = RENDER[slug];
  return r ? r(ctx) : null;
}
