/**
 * Ready-to-paste client configuration snippets. Pure (no React / server deps) so it is shared by the
 * "Use key" dialog, the docs site and the landing page, and unit-tested.
 */
export interface SnippetBlock {
  title: string;
  /** File the snippet belongs in, shown as a caption (e.g. `~/.codex/config.toml`). */
  filename?: string;
  lang: "bash" | "python" | "javascript" | "toml" | "json" | "text";
  code: string;
}

export interface SnippetTab {
  id: string;
  label: string;
  blocks: SnippetBlock[];
}

export interface SnippetOptions {
  /** Public origin of the app, no trailing slash (e.g. https://example.com). */
  appUrl: string;
  /** Full key when just created; otherwise a placeholder is used. */
  apiKey?: string | null;
  /** Example model id. */
  model?: string;
  /** Example Anthropic-format model id. */
  claudeModel?: string;
  /** Example Gemini-format model id. */
  geminiModel?: string;
  siteName?: string;
}

export const KEY_PLACEHOLDER = "sk-pp-YOUR_API_KEY";

export function normalizeOrigin(url: string): string {
  return url.replace(/\/+$/, "");
}

/** OpenAI-style base URL (`.../v1`). */
export function openaiBaseUrl(appUrl: string): string {
  return `${normalizeOrigin(appUrl)}/v1`;
}

export function buildSnippets(opts: SnippetOptions): SnippetTab[] {
  const origin = normalizeOrigin(opts.appUrl);
  const base = `${origin}/v1`;
  const key = opts.apiKey || KEY_PLACEHOLDER;
  const model = opts.model || "gpt-6-sol";
  const claude = opts.claudeModel || "claude-sonnet-5-5";
  const gemini = opts.geminiModel || "gemini-3.1-pro";
  const name = opts.siteName || "ProviderProxy";
  const providerId = "providerproxy";

  return [
    {
      id: "curl",
      label: "curl",
      blocks: [
        {
          title: "OpenAI-compatible (Chat Completions)",
          lang: "bash",
          code: `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Say hello in five words."}]
  }'`,
        },
        {
          title: "Anthropic-compatible (Messages)",
          lang: "bash",
          code: `curl ${base}/messages \\
  -H "x-api-key: ${key}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${claude}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Say hello in five words."}]
  }'`,
        },
        {
          title: "Gemini-compatible (generateContent)",
          lang: "bash",
          code: `curl "${origin}/v1beta/models/${gemini}:generateContent" \\
  -H "x-goog-api-key: ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "contents": [{"role": "user", "parts": [{"text": "Say hello in five words."}]}]
  }'`,
        },
      ],
    },
    {
      id: "python",
      label: "Python",
      blocks: [
        {
          title: "OpenAI SDK",
          filename: "pip install openai",
          lang: "python",
          code: `from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key="${key}",
)

resp = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Say hello in five words."}],
)
print(resp.choices[0].message.content)`,
        },
        {
          title: "Anthropic SDK",
          filename: "pip install anthropic",
          lang: "python",
          code: `import anthropic

client = anthropic.Anthropic(
    base_url="${origin}",   # the SDK appends /v1/messages
    api_key="${key}",
)

msg = client.messages.create(
    model="${claude}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Say hello in five words."}],
)
print(msg.content[0].text)`,
        },
      ],
    },
    {
      id: "node",
      label: "Node.js",
      blocks: [
        {
          title: "OpenAI SDK",
          filename: "npm install openai",
          lang: "javascript",
          code: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: process.env.PROVIDERPROXY_API_KEY, // ${opts.apiKey ? "export PROVIDERPROXY_API_KEY=" + key : "your sk-pp-... key"}
});

const resp = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Say hello in five words." }],
});
console.log(resp.choices[0].message.content);`,
        },
      ],
    },
    {
      id: "codex",
      label: "Codex CLI",
      blocks: [
        {
          title: "Provider config",
          filename: "~/.codex/config.toml",
          lang: "toml",
          code: `# at the very top of the file, before any [section]
model_provider = "${providerId}"
model = "${model}"
model_reasoning_effort = "high"
disable_response_storage = true
supports_websockets = false

[model_providers.${providerId}]
name = "${name}"
base_url = "${base}"
wire_api = "responses"
requires_openai_auth = true`,
        },
        {
          title: "API key (also used by the Codex app and VS Code extension)",
          filename: "~/.codex/auth.json",
          lang: "json",
          code: `{
  "OPENAI_API_KEY": "${key}"
}`,
        },
      ],
    },
    {
      id: "claude-code",
      label: "Claude Code",
      blocks: [
        {
          title: "Environment variables",
          filename: "~/.bashrc or ~/.zshrc",
          lang: "bash",
          code: `export ANTHROPIC_BASE_URL="${origin}"
export ANTHROPIC_AUTH_TOKEN="${key}"
export ANTHROPIC_MODEL="${claude}"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export CLAUDE_CODE_ATTRIBUTION_HEADER=0`,
        },
        {
          title: "Or in settings (all sessions and the IDE extensions)",
          filename: "~/.claude/settings.json",
          lang: "json",
          code: `{
  "env": {
    "ANTHROPIC_BASE_URL": "${origin}",
    "ANTHROPIC_AUTH_TOKEN": "${key}",
    "ANTHROPIC_MODEL": "${claude}",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0"
  }
}`,
        },
      ],
    },
    {
      id: "opencode",
      label: "OpenCode",
      blocks: [
        {
          title: "Provider config",
          filename: "opencode.json",
          lang: "json",
          code: `{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "${providerId}": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "${name}",
      "options": {
        "baseURL": "${base}",
        "apiKey": "{env:PROVIDERPROXY_API_KEY}"
      },
      "models": {
        "${model}": { "name": "${model}" },
        "${claude}": { "name": "${claude}" }
      }
    }
  }
}`,
        },
        {
          title: "Environment variable",
          lang: "bash",
          code: `export PROVIDERPROXY_API_KEY="${key}"`,
        },
      ],
    },
    {
      id: "other",
      label: "Cursor / other",
      blocks: [
        {
          title: "Any OpenAI-compatible client",
          lang: "text",
          code: `Base URL:  ${base}
API key:   ${key}
Model:     ${model}`,
        },
        {
          title: "Cursor",
          lang: "text",
          code: `Settings > Models > OpenAI API Key
  1. Paste your key into "OpenAI API Key".
  2. Enable "Override OpenAI Base URL" and set it to ${base}
  3. Add a custom model named ${model}`,
        },
      ],
    },
  ];
}
