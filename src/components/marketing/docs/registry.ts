/** Docs navigation: single source of truth for slugs, titles and ordering. */
export interface DocPage {
  /** Path under /docs ("" is the index/quickstart). */
  slug: string;
  title: string;
  description: string;
}

export interface DocSection {
  title: string;
  pages: DocPage[];
}

export const DOC_SECTIONS: DocSection[] = [
  {
    title: "Getting started",
    pages: [
      { slug: "", title: "Quickstart", description: "Make your first request in two minutes." },
      { slug: "authentication", title: "Authentication", description: "API keys and the headers we accept." },
    ],
  },
  {
    title: "OpenAI-compatible API",
    pages: [
      { slug: "openai/chat-completions", title: "Chat completions", description: "POST /v1/chat/completions" },
      { slug: "openai/responses", title: "Responses", description: "POST /v1/responses" },
      { slug: "openai/completions", title: "Completions", description: "POST /v1/completions" },
      { slug: "openai/embeddings", title: "Embeddings", description: "POST /v1/embeddings" },
      { slug: "openai/images", title: "Images", description: "POST /v1/images/generations" },
      { slug: "openai/audio", title: "Audio", description: "Speech, transcription and translation." },
      { slug: "openai/videos", title: "Videos", description: "POST /v1/videos: create, poll, download." },
      { slug: "openai/moderations", title: "Moderations", description: "POST /v1/moderations" },
      { slug: "openai/models", title: "Models", description: "GET /v1/models" },
    ],
  },
  {
    title: "Anthropic-compatible API",
    pages: [
      { slug: "anthropic/messages", title: "Messages", description: "POST /v1/messages" },
      { slug: "anthropic/count-tokens", title: "Count tokens", description: "POST /v1/messages/count_tokens" },
      { slug: "anthropic/headers", title: "Headers & versions", description: "anthropic-version, anthropic-beta and auth." },
    ],
  },
  {
    title: "Gemini-compatible API",
    pages: [{ slug: "gemini", title: "Gemini API", description: "generateContent, streaming, countTokens and embeddings." }],
  },
  {
    title: "Guides",
    pages: [
      { slug: "streaming", title: "Streaming", description: "Server-sent events across all formats." },
      { slug: "tools", title: "Tools & function calling", description: "Let models call your functions." },
      { slug: "images", title: "Image generation", description: "Generate images and track their cost." },
      { slug: "batches", title: "Batches", description: "Anthropic Message Batches and the OpenAI Batch API at 50% off." },
      { slug: "rate-limits", title: "Rate limits & concurrency", description: "429s, retry-after and concurrency slots." },
      { slug: "billing", title: "Billing & pay-as-you-go", description: "Balance, pools, multipliers and limits." },
      { slug: "pricing-api", title: "Pricing API", description: "Read live prices from the API to keep costs in sync." },
      { slug: "errors", title: "Error codes", description: "Every error code, its HTTP status and fix." },
    ],
  },
  {
    title: "Client setup",
    pages: [
      { slug: "clients/codex-cli", title: "Codex CLI", description: "Use Codex CLI with your key." },
      { slug: "clients/claude-code", title: "Claude Code", description: "Use Claude Code with your key." },
      { slug: "clients/opencode", title: "OpenCode", description: "Use OpenCode with your key." },
      { slug: "clients/cursor", title: "Cursor & other tools", description: "Any OpenAI-compatible client." },
      { slug: "clients/python", title: "Python", description: "OpenAI and Anthropic SDKs." },
      { slug: "clients/node", title: "Node.js", description: "OpenAI SDK for JavaScript/TypeScript." },
    ],
  },
];

export const ALL_DOC_PAGES: DocPage[] = DOC_SECTIONS.flatMap((s) => s.pages);

export function findDocPage(slug: string): DocPage | undefined {
  return ALL_DOC_PAGES.find((p) => p.slug === slug);
}

export function docHref(slug: string): string {
  return slug ? `/docs/${slug}` : "/docs";
}

export function prevNext(slug: string): { prev: DocPage | null; next: DocPage | null } {
  const i = ALL_DOC_PAGES.findIndex((p) => p.slug === slug);
  return { prev: i > 0 ? ALL_DOC_PAGES[i - 1] : null, next: i >= 0 && i < ALL_DOC_PAGES.length - 1 ? ALL_DOC_PAGES[i + 1] : null };
}
