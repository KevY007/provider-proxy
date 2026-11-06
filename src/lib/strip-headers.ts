/**
 * Headers a provider or an API key can remove from what is sent upstream (nothing is stripped by default).
 * An entry is a header name ("x-app") or one flag of anthropic-beta ("anthropic-beta:claude-code-20250219").
 * Pure data and helpers, safe to import from client components.
 */
export const COMMON_STRIP_HEADERS: Array<{ id: string; label: string; hint: string }> = [
  { id: "user-agent", label: "user-agent", hint: "the client's identity string" },
  { id: "x-app", label: "x-app", hint: "Claude Code's client marker" },
  { id: "anthropic-beta", label: "anthropic-beta (all flags)", hint: "Anthropic beta feature flags, incl. claude-code" },
  { id: "anthropic-beta:claude-code-20250219", label: "anthropic-beta: claude-code flag only", hint: "keeps the other beta flags" },
  { id: "anthropic-version", label: "anthropic-version", hint: "the gateway then sends its default" },
  { id: "openai-beta", label: "openai-beta", hint: "OpenAI beta features (e.g. assistants)" },
  { id: "openai-organization", label: "openai-organization", hint: "OpenAI organization id" },
  { id: "openai-project", label: "openai-project", hint: "OpenAI project id" },
  { id: "idempotency-key", label: "idempotency-key", hint: "request de-duplication key" },
];

/** Credentials and transport headers can never be stripped. */
const PROTECTED = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key", "content-type", "content-length", "host", "accept"]);
const ENTRY = /^[a-z0-9][a-z0-9-]*(?::[a-z0-9._-]+)?$/;

/** Clean a stored/typed list: lowercase, trimmed, deduplicated, valid names only, protected headers dropped. */
export function normalizeStripList(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,;]+/) : [];
  const out: string[] = [];
  for (const p of parts) {
    if (typeof p !== "string") continue;
    const e = p.trim().toLowerCase();
    if (!e || !ENTRY.test(e) || PROTECTED.has(e.split(":")[0]) || out.includes(e)) continue;
    out.push(e);
  }
  return out.slice(0, 40);
}

/** Remove the listed headers (keys are lower-case) from `h` in place. */
export function applyStripHeaders(h: Record<string, string>, list: readonly string[]): void {
  for (const raw of list) {
    const [name, flag] = raw.toLowerCase().split(":");
    if (!name || PROTECTED.has(name)) continue;
    if (flag && name === "anthropic-beta") {
      const kept = (h[name] ?? "").split(",").map((s) => s.trim()).filter((s) => s && s.toLowerCase() !== flag);
      if (kept.length) h[name] = kept.join(",");
      else delete h[name];
    } else if (!flag) {
      delete h[name];
    }
  }
}
