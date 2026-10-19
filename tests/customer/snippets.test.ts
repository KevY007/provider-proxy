import { describe, expect, it } from "vitest";
import { KEY_PLACEHOLDER, buildSnippets, openaiBaseUrl } from "@/components/customer/snippets";

const find = (tabs: ReturnType<typeof buildSnippets>, id: string) => tabs.find((t) => t.id === id)!;
const text = (tabs: ReturnType<typeof buildSnippets>, id: string) => find(tabs, id).blocks.map((b) => b.code).join("\n");

describe("config snippet generation", () => {
  const opts = { appUrl: "https://api.example.com/", apiKey: "sk-pp-SECRET123", model: "gpt-6-sol", claudeModel: "claude-sonnet-5-5", geminiModel: "gemini-3.1-pro" };
  const tabs = buildSnippets(opts);

  it("covers every client in the brief", () => {
    expect(tabs.map((t) => t.id)).toEqual(["curl", "python", "node", "codex", "claude-code", "opencode", "other"]);
  });

  it("fills base URL and key everywhere, normalizing the trailing slash", () => {
    expect(openaiBaseUrl("https://api.example.com//")).toBe("https://api.example.com/v1");
    for (const id of ["curl", "python", "node", "codex", "opencode", "other"]) expect(text(tabs, id)).toContain("https://api.example.com/v1");
    expect(text(tabs, "curl")).toContain("Authorization: Bearer sk-pp-SECRET123");
    expect(text(tabs, "curl")).toContain("https://api.example.com/v1/messages");
    expect(text(tabs, "curl")).toContain("https://api.example.com/v1beta/models/gemini-3.1-pro:generateContent");
  });

  it("uses a placeholder when no full key is available", () => {
    const t = buildSnippets({ appUrl: "https://x.test" });
    expect(text(t, "curl")).toContain(KEY_PLACEHOLDER);
    expect(text(t, "claude-code")).toContain(KEY_PLACEHOLDER);
  });

  it("Codex CLI config.toml has provider table with env key and responses wire api", () => {
    const toml = find(tabs, "codex").blocks[0];
    expect(toml.filename).toBe("~/.codex/config.toml");
    expect(toml.code).toContain("[model_providers.providerproxy]");
    expect(toml.code).toContain('base_url = "https://api.example.com/v1"');
    expect(toml.code).toContain('env_key = "PROVIDERPROXY_API_KEY"');
    expect(toml.code).toContain('wire_api = "responses"');
  });

  it("Claude Code points ANTHROPIC_BASE_URL at the origin (no /v1) with ANTHROPIC_AUTH_TOKEN", () => {
    const sh = find(tabs, "claude-code").blocks[0].code;
    expect(sh).toContain('ANTHROPIC_BASE_URL="https://api.example.com"');
    expect(sh).toContain('ANTHROPIC_AUTH_TOKEN="sk-pp-SECRET123"');
  });

  it("OpenCode config is valid JSON", () => {
    const json = find(tabs, "opencode").blocks[0].code;
    const parsed = JSON.parse(json);
    expect(parsed.provider.providerproxy.options.baseURL).toBe("https://api.example.com/v1");
    expect(Object.keys(parsed.provider.providerproxy.models)).toContain("gpt-6-sol");
  });
});
