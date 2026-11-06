/**
 * Client identities (user-agent, plus the marker headers some clients send) that a provider or an API key can present
 * upstream. Pure data, safe to import from client components.
 *
 * A stored value is one of: "" / "passthrough" (the caller's own), a preset id below, or any other text (sent as is).
 */
export interface UserAgentPreset {
  id: string;
  label: string;
  userAgent: string;
  headers?: Record<string, string>;
}

export const USER_AGENT_PRESETS: UserAgentPreset[] = [
  { id: "claude-code", label: "Claude Code", userAgent: "claude-cli/2.1.318 (external, cli)", headers: { "x-app": "cli" } },
  { id: "codex-cli", label: "Codex CLI", userAgent: "codex_cli_rs/0.50.0" },
  { id: "anthropic-python", label: "Anthropic Python SDK", userAgent: "Anthropic/Python 0.40.0" },
  { id: "openai-python", label: "OpenAI Python SDK", userAgent: "OpenAI/Python 1.55.0" },
  { id: "curl", label: "curl", userAgent: "curl/8.5.0" },
  { id: "chrome", label: "Chrome browser", userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" },
];

export const PASSTHROUGH = "passthrough";

/** "" / "passthrough" / non-strings mean the caller's own identity. */
export function isPassthrough(v: unknown): boolean {
  return typeof v !== "string" || !v.trim() || v.trim() === PASSTHROUGH;
}

export function findUserAgentPreset(v: unknown): UserAgentPreset | null {
  if (typeof v !== "string") return null;
  const id = v.trim();
  return USER_AGENT_PRESETS.find((p) => p.id === id) ?? null;
}

/** Control characters and an unbounded length never reach a header. */
export function cleanUserAgent(v: string): string {
  return v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 300);
}
