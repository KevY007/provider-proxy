import { describe, expect, it } from "vitest";
import { buildGuides, exampleModels, type GuideModel, type IntegrationGuide } from "@/components/customer/integrations";
import { KEY_PLACEHOLDER } from "@/components/customer/snippets";

const m = (slug: string, vendor: string, caps = ["chat", "responses"]): GuideModel => ({ slug, displayName: slug, vendor, capabilities: caps });
const STUDIO = [m("gpt-6-astra", "openai"), m("gpt-6.1-sol", "openai"), m("gpt-6-luna", "openai"), m("gpt-image-2", "openai", ["images"])];
const CODING = [m("claude-opus-5-5", "anthropic"), m("claude-sonnet-5", "anthropic"), m("claude-haiku-4-5", "anthropic")];

const all = (g: IntegrationGuide) => g.steps.flatMap((s) => [...(s.code ?? []), ...(s.os ? [...s.os.unix, ...s.os.windows] : [])]).map((c) => c.code).join("\n");
const guide = (gs: IntegrationGuide[], id: string) => gs.find((g) => g.id === id)!;

describe("integration guides", () => {
  it("picks models the key's pool really serves", () => {
    const ex = exampleModels(CODING);
    expect(ex).toMatchObject({ sonnet: "claude-sonnet-5", opus: "claude-opus-5-5", haiku: "claude-haiku-4-5" });
    expect(exampleModels(STUDIO).gpt).toBe("gpt-6.1-sol");
  });

  it("Claude Code: origin base URL, the key as auth token, without overriding model selection", () => {
    const gs = buildGuides({ appUrl: "https://p.example.com/", apiKey: "sk-pp-SECRET", siteName: "Acme Proxy", poolName: "Coding", models: CODING });
    const cc = guide(gs, "claude-code");
    const settings = JSON.parse(cc.steps.find((s) => s.title.startsWith("Paste"))!.code![0].code) as { env: Record<string, string> };
    expect(settings.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://p.example.com",
      ANTHROPIC_AUTH_TOKEN: "sk-pp-SECRET",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(all(cc)).not.toMatch(/ANTHROPIC_(?:DEFAULT_w+_)?MODEL/);
    // optional "this terminal only" alternative: the same variables per shell
    const temp = cc.steps.find((s) => s.title.startsWith("Optional"))!.os!;
    expect(temp.unix[0].code).toContain('export ANTHROPIC_AUTH_TOKEN="sk-pp-SECRET"');
    expect(temp.windows[0].code).toContain('$env:ANTHROPIC_BASE_URL="https://p.example.com"');
    expect(temp.windows[1].code).toContain("set ANTHROPIC_AUTH_TOKEN=sk-pp-SECRET");
    expect(temp.windows[1].code.endsWith("\nclaude")).toBe(true);
    expect(cc.warning).toBeUndefined();
    // the Codex guide warns: no GPT models in this pool
    expect(guide(gs, "codex").warning).toMatch(/Coding pool has no OpenAI models/);
  });

  it("Codex: /v1 base URL over HTTP, OpenAI auth from auth.json, a model of the pool", () => {
    const gs = buildGuides({ appUrl: "https://p.example.com", apiKey: "sk-pp-SECRET", siteName: "Acme Proxy", models: STUDIO });
    const text = all(guide(gs, "codex"));
    expect(text).toContain('base_url = "https://p.example.com/v1"');
    expect(text).toContain("supports_websockets = false");
    expect(text).toContain('model = "gpt-6.1-sol"');
    expect(text).toContain('"OPENAI_API_KEY": "sk-pp-SECRET"');
    expect(text).toContain("[model_providers.acme-proxy]");
  });

  it("OpenCode only declares providers the pool has models for; image models are left out of chat apps", () => {
    const gs = buildGuides({ appUrl: "https://p.example.com", models: STUDIO });
    const cfg = JSON.parse(guide(gs, "opencode").steps[2].code![0].code) as { provider: Record<string, { models: Record<string, unknown> }> };
    expect(Object.keys(cfg.provider)).toEqual(["openai"]);
    expect(Object.keys(cfg.provider.openai.models)).toEqual(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"]);
    expect(all(guide(gs, "cursor"))).not.toContain("gpt-image-2");
  });

  it("uses the placeholder without a key, every guide has steps, Gemini CLI only with Gemini models", () => {
    const gs = buildGuides({ appUrl: "https://p.example.com", models: STUDIO });
    expect(all(guide(gs, "aider"))).toContain(KEY_PLACEHOLDER);
    for (const g of gs) expect(g.steps.length).toBeGreaterThan(0);
    expect(gs.some((g) => g.id === "gemini-cli")).toBe(false);
    expect(buildGuides({ appUrl: "https://p.example.com", models: [m("gemini-3.1-pro", "google")] }).some((g) => g.id === "gemini-cli")).toBe(true);
    expect(new Set(gs.map((g) => g.id)).size).toBe(gs.length);
  });
});
