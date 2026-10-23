/**
 * Step-by-step setup guides for popular coding agents, IDEs, chat apps and SDKs ("Use key" dialog). Pure (no React /
 * server deps) and unit-tested. Every guide is generated for ONE key: its base URLs, its secret (or a placeholder) and
 * the models its pool can actually call, so what the customer copies works as is.
 *
 * Conventions that matter for this gateway:
 *  - OpenAI-style clients use `<origin>/v1` (they append /chat/completions or /responses).
 *  - Anthropic-style clients that append /v1/messages themselves (Claude Code, Claude Desktop, the Anthropic SDKs) use
 *    the bare origin; clients that append only /messages use `<origin>/v1`.
 *  - Gemini-style clients use the bare origin (they append /v1beta/...).
 *  - Any model can be called through any of the three APIs (the gateway translates), so an OpenAI-compatible app can
 *    use Claude models too.
 */
import type { SnippetBlock } from "./snippets";
import { KEY_PLACEHOLDER, normalizeOrigin } from "./snippets";

export interface GuideModel {
  slug: string;
  displayName: string;
  vendor: string;
  capabilities: string[];
}

export type GuideCode = Pick<SnippetBlock, "title" | "filename" | "lang" | "code">;

export interface GuideStep {
  title: string;
  text?: string;
  /** Same for every OS. */
  code?: GuideCode[];
  /** Per OS (macOS / Linux, Windows). */
  os?: { unix: GuideCode[]; windows: GuideCode[] };
}

export type GuideCategory = "Coding agents" | "IDE extensions" | "Desktop & chat apps" | "SDKs & API";

export interface IntegrationGuide {
  id: string;
  label: string;
  category: GuideCategory;
  /** One line: what it is and when to pick it. */
  summary: string;
  /** Shown as a warning when the key's pool lacks the models this client is best with. */
  warning?: string;
  steps: GuideStep[];
  notes?: string[];
}

export interface GuideOptions {
  appUrl: string;
  apiKey?: string | null;
  siteName?: string;
  /** The pool the key is in (for wording). */
  poolName?: string | null;
  /** Models this key can call (its pool, narrowed by the key's own model list). */
  models: GuideModel[];
}

const isText = (m: GuideModel) => m.capabilities.includes("chat") || m.capabilities.includes("responses");

/** First slug of `prefer` that is available, else the first available. */
function pick(models: GuideModel[], prefer: string[]): string | undefined {
  for (const p of prefer) if (models.some((m) => m.slug === p)) return p;
  return models[0]?.slug;
}

export function exampleModels(models: GuideModel[]) {
  const text = models.filter(isText);
  const gpt = text.filter((m) => m.vendor === "openai");
  const claude = text.filter((m) => m.vendor === "anthropic");
  const gemini = text.filter((m) => m.vendor === "google");
  const sonnet = pick(claude.filter((m) => /sonnet/.test(m.slug)), ["claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6"]) ?? claude[0]?.slug;
  const opus = pick(claude.filter((m) => /opus/.test(m.slug)), ["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]) ?? sonnet;
  const haiku = pick(claude.filter((m) => /haiku/.test(m.slug)), ["claude-haiku-5-5", "claude-haiku-4-5"]) ?? sonnet;
  return {
    gpt: pick(gpt, ["gpt-6.1-sol", "gpt-6-sol", "gpt-6-astra", "gpt-5.6-sol"]),
    gptModels: gpt,
    claudeModels: claude,
    geminiModels: gemini,
    sonnet,
    opus,
    haiku,
    gemini: pick(gemini, ["gemini-3.1-pro", "gemini-3.8-flash"]),
    any: pick(text, ["gpt-6.1-sol", "claude-sonnet-5", "gpt-6-sol"]),
  };
}

const slugId = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "proxy";

export function buildGuides(o: GuideOptions): IntegrationGuide[] {
  const origin = normalizeOrigin(o.appUrl);
  const base = `${origin}/v1`;
  const key = o.apiKey || KEY_PLACEHOLDER;
  const name = o.siteName || "ProviderProxy";
  const id = slugId(name);
  const envVar = `${id.replace(/-/g, "_").toUpperCase()}_API_KEY`;
  const ex = exampleModels(o.models);
  const pool = o.poolName ? `the ${o.poolName} pool` : "this key's pool";
  const anyModel = ex.any ?? "MODEL_ID";
  const gpt = ex.gpt ?? anyModel;
  const noClaude = ex.claudeModels.length ? undefined : `${pool[0].toUpperCase()}${pool.slice(1)} has no Claude models. This client works best with Claude: use a key in a pool with Claude models (e.g. Coding), or pick one of this key's models below.`;
  const noGpt = ex.gptModels.length ? undefined : `${pool[0].toUpperCase()}${pool.slice(1)} has no OpenAI models. This client works best with GPT models: use a key in a pool with GPT models (e.g. Studio), or set the model to one of this key's models.`;
  const modelList = o.models.filter(isText).map((m) => m.slug);
  const listText = modelList.length ? modelList.join(", ") : "(no chat models in this key's pool)";
  const sonnet = ex.sonnet ?? anyModel;

  const openFile = (unixPath: string, winPath: string): GuideStep["os"] => ({
    unix: [{ title: "Create / open the file", lang: "bash", code: `mkdir -p "$(dirname ${unixPath})" && nano ${unixPath}` }],
    windows: [{ title: "Create / open the file (PowerShell)", lang: "text", code: `New-Item -ItemType Directory -Force (Split-Path "${winPath}") | Out-Null; notepad "${winPath}"` }],
  });

  const guides: IntegrationGuide[] = [];
  /** Shell lines that set variables for the current terminal only. */
  const envLines = (env: Record<string, string>, shell: "unix" | "powershell" | "cmd") =>
    Object.entries(env)
      .map(([k, v]) => (shell === "unix" ? `export ${k}="${v}"` : shell === "powershell" ? `$env:${k}="${v}"` : `set ${k}=${v}`))
      .join("\n");

  // ------------------------------------------------------------------------------------------------ coding agents
  const claudeEnv = {
    ANTHROPIC_BASE_URL: origin,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: sonnet,
    ANTHROPIC_DEFAULT_OPUS_MODEL: ex.opus ?? sonnet,
    ANTHROPIC_DEFAULT_SONNET_MODEL: sonnet,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: ex.haiku ?? sonnet,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
  };
  guides.push({
    id: "claude-code",
    label: "Claude Code",
    category: "Coding agents",
    summary: "Anthropic's coding agent (terminal, VS Code and JetBrains extensions). Runs on this key instead of a Claude subscription.",
    warning: noClaude,
    steps: [
      { title: "Install Claude Code (skip if you have it)", os: { unix: [{ title: "Install", lang: "bash", code: "curl -fsSL https://claude.ai/install.sh | bash" }], windows: [{ title: "Install (PowerShell)", lang: "text", code: "irm https://claude.ai/install.ps1 | iex" }] } },
      {
        title: "Open your Claude Code settings file",
        text: "If the file already exists, keep what is in it and only add the \"env\" block from the next step.",
        os: openFile("~/.claude/settings.json", "$HOME\\.claude\\settings.json"),
      },
      {
        title: "Paste this and save",
        text: "This makes every Claude Code session (terminal and IDE extensions) use your key. The DEFAULT_*_MODEL lines map Claude Code's built-in Opus / Sonnet / Haiku choices to models your key can use.",
        code: [{ title: "settings.json", filename: "~/.claude/settings.json", lang: "json", code: JSON.stringify({ env: claudeEnv }, null, 2) }],
      },
      {
        title: "If you were signed in with a Claude account, sign out once",
        text: "Start claude and run /logout, then restart it. Otherwise your subscription login can take precedence over the key.",
        code: [{ title: "In Claude Code", lang: "text", code: "/logout" }],
      },
      {
        title: "Start and check",
        text: "Run claude in your project. /status must show the base URL above. Switch models any time with /model.",
        code: [{ title: "Terminal", lang: "bash", code: `claude\n# inside Claude Code:\n/status\n/model ${ex.opus ?? sonnet}` }],
      },
      {
        title: "Optional: skip the settings file and use the key in one terminal only",
        text: "Instead of steps 2-3, paste this into a terminal. The variables last until you close that window; new windows start without them.",
        os: {
          unix: [{ title: "Terminal (bash / zsh)", lang: "bash", code: `${envLines(claudeEnv, "unix")}\nclaude` }],
          windows: [
            { title: "PowerShell", lang: "text", code: `${envLines(claudeEnv, "powershell")}\nclaude` },
            { title: "Command Prompt (cmd)", lang: "text", code: `${envLines(claudeEnv, "cmd")}\nclaude` },
          ],
        },
      },
    ],
    notes: [`Models this key can use: ${listText}.`],
  });

  const codexToml = `# Put these lines at the very TOP of the file, before any [section]
model_provider = "${id}"
model = "${gpt}"
model_reasoning_effort = "high"
disable_response_storage = true
supports_websockets = false

[model_providers.${id}]
name = "${name}"
base_url = "${base}"
wire_api = "responses"
requires_openai_auth = true`;
  guides.push({
    id: "codex",
    label: "Codex CLI / App",
    category: "Coding agents",
    summary: "OpenAI's coding agent: Codex CLI, the Codex desktop app and the VS Code extension all read the same two files.",
    warning: noGpt,
    steps: [
      { title: "Install Codex CLI (skip if you use the app or the extension)", code: [{ title: "Terminal", lang: "bash", code: "npm install -g @openai/codex" }] },
      { title: "Open the Codex config file", os: openFile("~/.codex/config.toml", "$HOME\\.codex\\config.toml") },
      { title: "Paste this at the top and save", code: [{ title: "config.toml", filename: "~/.codex/config.toml", lang: "toml", code: codexToml }] },
      {
        title: "Put your key in Codex's auth file",
        text: "This replaces a ChatGPT sign-in in Codex. Rename the old file instead of deleting it if you want to switch back later.",
        os: {
          unix: [...(openFile("~/.codex/auth.json", "")!.unix), { title: "auth.json", filename: "~/.codex/auth.json", lang: "json", code: JSON.stringify({ OPENAI_API_KEY: key }, null, 2) }],
          windows: [...(openFile("", "$HOME\\.codex\\auth.json")!.windows), { title: "auth.json", filename: "%USERPROFILE%\\.codex\\auth.json", lang: "json", code: JSON.stringify({ OPENAI_API_KEY: key }, null, 2) }],
        },
      },
      {
        title: "Start and check",
        text: "Restart the Codex app / VS Code if they were open. In the CLI, /status shows the provider and /model switches model and reasoning effort.",
        code: [{ title: "Terminal", lang: "bash", code: "codex\n# inside Codex:\n/status" }],
      },
    ],
    notes: [`Models this key can use: ${listText}.`, "supports_websockets = false is required: this gateway streams over HTTP."],
  });

  const openCodeProviders: Record<string, unknown> = {};
  if (ex.gptModels.length)
    openCodeProviders.openai = { options: { baseURL: base, apiKey: key }, models: Object.fromEntries(ex.gptModels.map((m) => [m.slug, { name: m.displayName, options: { store: false } }])) };
  if (ex.claudeModels.length) openCodeProviders.anthropic = { npm: "@ai-sdk/anthropic", options: { baseURL: base, apiKey: key }, models: Object.fromEntries(ex.claudeModels.map((m) => [m.slug, { name: m.displayName }])) };
  const others = o.models.filter((m) => isText(m) && m.vendor !== "openai" && m.vendor !== "anthropic");
  if (others.length || !Object.keys(openCodeProviders).length)
    openCodeProviders[id] = { npm: "@ai-sdk/openai-compatible", name, options: { baseURL: base, apiKey: key }, models: Object.fromEntries((others.length ? others : o.models.filter(isText)).map((m) => [m.slug, { name: m.displayName }])) };
  guides.push({
    id: "opencode",
    label: "OpenCode",
    category: "Coding agents",
    summary: "Open-source coding agent for the terminal. Works with every model on this key.",
    steps: [
      { title: "Install OpenCode (skip if you have it)", code: [{ title: "Terminal", lang: "bash", code: "npm install -g opencode-ai" }] },
      { title: "Open the OpenCode config file", os: openFile("~/.config/opencode/opencode.json", "$HOME\\.config\\opencode\\opencode.json") },
      { title: "Paste this and save", code: [{ title: "opencode.json", filename: "~/.config/opencode/opencode.json", lang: "json", code: JSON.stringify({ $schema: "https://opencode.ai/config.json", provider: openCodeProviders }, null, 2) }] },
      { title: "Start and pick a model", text: "Run opencode, type /models and choose one of the models listed under the providers above.", code: [{ title: "Terminal", lang: "bash", code: "opencode\n# inside OpenCode:\n/models" }] },
    ],
  });

  guides.push({
    id: "aider",
    label: "Aider",
    category: "Coding agents",
    summary: "Terminal pair-programmer that edits files in your git repo.",
    steps: [
      { title: "Install Aider (skip if you have it)", code: [{ title: "Terminal", lang: "bash", code: "python -m pip install aider-install\naider-install" }] },
      {
        title: "Point Aider at this key and start it",
        text: "The openai/ prefix tells Aider to use the OpenAI-compatible API; any model of this key works, Claude models included.",
        os: {
          unix: [{ title: "macOS / Linux", lang: "bash", code: `export OPENAI_API_BASE="${base}"\nexport OPENAI_API_KEY="${key}"\naider --model openai/${anyModel}` }],
          windows: [{ title: "PowerShell", lang: "text", code: `$env:OPENAI_API_BASE="${base}"\n$env:OPENAI_API_KEY="${key}"\naider --model openai/${anyModel}` }],
        },
      },
    ],
    notes: ["To keep it, add the two variables to ~/.zshrc / ~/.bashrc, or on Windows run [Environment]::SetEnvironmentVariable(\"OPENAI_API_KEY\", \"<key>\", \"User\") (same for OPENAI_API_BASE)."],
  });

  guides.push({
    id: "hermes",
    label: "Hermes Agent",
    category: "Coding agents",
    summary: "Nous Research's terminal agent (macOS / Linux, Windows via WSL).",
    steps: [
      { title: "Install Hermes (skip if you have it)", code: [{ title: "Terminal", lang: "bash", code: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash" }] },
      { title: "Set the model and base URL", code: [{ title: "config.yaml", filename: "~/.hermes/config.yaml", lang: "text", code: `model:\n  provider: custom\n  default: ${anyModel}\n  base_url: ${base}\n  api_mode: chat_completions` }] },
      { title: "Set your key", code: [{ title: ".env", filename: "~/.hermes/.env", lang: "bash", code: `OPENAI_API_KEY=${key}` }] },
      { title: "Start it", code: [{ title: "Terminal", lang: "bash", code: "hermes" }] },
    ],
  });

  if (ex.geminiModels.length)
    guides.push({
      id: "gemini-cli",
      label: "Gemini CLI",
      category: "Coding agents",
      summary: "Google's terminal agent, using this key's Gemini models.",
      steps: [
        { title: "Install Gemini CLI (skip if you have it)", code: [{ title: "Terminal", lang: "bash", code: "npm install -g @google/gemini-cli" }] },
        {
          title: "Point it at this key and start it",
          os: {
            unix: [{ title: "macOS / Linux", lang: "bash", code: `export GOOGLE_GEMINI_BASE_URL="${origin}"\nexport GEMINI_API_KEY="${key}"\ngemini -m ${ex.gemini}` }],
            windows: [{ title: "PowerShell", lang: "text", code: `$env:GOOGLE_GEMINI_BASE_URL="${origin}"\n$env:GEMINI_API_KEY="${key}"\ngemini -m ${ex.gemini}` }],
          },
        },
      ],
    });

  // ------------------------------------------------------------------------------------------------ IDE extensions
  guides.push({
    id: "cursor",
    label: "Cursor",
    category: "IDE extensions",
    summary: "Use this key for Cursor's chat and agent with your own models.",
    steps: [
      { title: "Open Cursor Settings", text: "Cursor menu > Settings > Cursor Settings > Models (on Windows: File > Preferences > Cursor Settings > Models)." },
      { title: "Add your key", text: `Under "API Keys", paste your key into "OpenAI API Key" and turn on "Override OpenAI Base URL".`, code: [{ title: "Values", lang: "text", code: `OpenAI API Key:            ${key}\nOverride OpenAI Base URL:  ${base}` }] },
      { title: "Add the models", text: `Click "+ Add model" and add each model you want, exactly as written. Turn off Cursor's own models you will not use so requests are not sent elsewhere.`, code: [{ title: "Model names", lang: "text", code: modelList.join("\n") || anyModel }] },
      { title: "Verify", text: "Click Verify next to the key, then pick one of the models in the chat panel's model picker." },
    ],
    notes: ["Cursor's own features (Tab completion, some background agents) still need a Cursor plan; chat and agent with these models run on your key."],
  });

  guides.push({
    id: "cline",
    label: "Cline / Roo Code / Kilo Code",
    category: "IDE extensions",
    summary: "VS Code coding agents. The setup is the same in all three.",
    steps: [
      { title: "Open the extension's settings", text: "Click the extension's icon in the VS Code sidebar, then the gear icon (Settings / API Configuration)." },
      {
        title: "Choose the OpenAI Compatible provider and fill in",
        code: [{ title: "Values", lang: "text", code: `API Provider:  OpenAI Compatible\nBase URL:      ${base}\nAPI Key:       ${key}\nModel ID:      ${ex.claudeModels.length ? sonnet : anyModel}` }],
      },
      { title: "Save and start a task", text: "Click Done / Save. Any model of this key works as the Model ID." },
    ],
    notes: ex.claudeModels.length ? [`For Claude models you can instead pick the "Anthropic" provider, tick "Use custom base URL", and enter ${origin} with your key.`] : undefined,
  });

  guides.push({
    id: "continue",
    label: "Continue",
    category: "IDE extensions",
    summary: "Open-source assistant for VS Code and JetBrains.",
    steps: [
      { title: "Open Continue's config", text: "In the Continue panel: the gear icon > Open config file (or open the file below directly).", os: openFile("~/.continue/config.yaml", "$HOME\\.continue\\config.yaml") },
      {
        title: "Add the models and save",
        code: [
          {
            title: "config.yaml",
            filename: "~/.continue/config.yaml",
            lang: "text",
            code: `name: ${name}\nversion: 1.0.0\nschema: v1\nmodels:\n${(modelList.length ? modelList.slice(0, 4) : [anyModel]).map((m) => `  - name: ${m}\n    provider: openai\n    model: ${m}\n    apiBase: ${base}\n    apiKey: ${key}\n    roles: [chat, edit, apply]`).join("\n")}`,
          },
        ],
      },
      { title: "Pick the model", text: "Select it in the model dropdown at the bottom of the Continue panel." },
    ],
  });

  guides.push({
    id: "zed",
    label: "Zed",
    category: "IDE extensions",
    summary: "Zed's agent panel with this key's models.",
    steps: [
      { title: "Open Zed's settings", text: "Zed > Settings > Open Settings (cmd-, / ctrl-,)." },
      {
        title: "Add this provider and save",
        text: "Merge it into your settings.json (keep your other settings).",
        code: [
          {
            title: "settings.json",
            lang: "json",
            code: JSON.stringify({ language_models: { openai_compatible: { [name]: { api_url: base, available_models: (modelList.length ? modelList : [anyModel]).map((m) => ({ name: m, max_tokens: 200000 })) } } } }, null, 2),
          },
        ],
      },
      { title: "Enter your key", text: `Open the Agent panel > settings, find "${name}" and paste your key (${key === KEY_PLACEHOLDER ? "sk-pp-..." : key.slice(0, 12) + "..."}). Then pick a model in the Agent panel.` },
    ],
  });

  // ------------------------------------------------------------------------------------------------ desktop & chat apps
  guides.push({
    id: "claude-desktop",
    label: "Claude Desktop",
    category: "Desktop & chat apps",
    summary: "The Claude desktop app, running on this key through its third-party gateway mode.",
    warning: noClaude,
    steps: [
      { title: "Turn on developer mode", text: "Settings > Help > Troubleshooting > Enable Developer Mode." },
      { title: "Open the gateway settings", text: "Settings > Developer > Configure Third-Party Inference. In Connection choose Gateway, and set Credential kind to Static API key." },
      { title: "Fill in", code: [{ title: "Values", lang: "text", code: `Gateway base URL:     ${origin}\nGateway API key:      ${key}\nGateway auth scheme:  x-api-key` }] },
      { title: "Test and apply", text: "Click Test connection, then Apply Changes. If the model list loads, it works." },
    ],
  });

  guides.push({
    id: "cherry-studio",
    label: "Cherry Studio",
    category: "Desktop & chat apps",
    summary: "Desktop chat client (Windows / macOS / Linux).",
    steps: [
      { title: "Add a provider", text: "Settings > Model Provider > + Add. Name it, and choose the type OpenAI (works for every model of this key)." },
      { title: "Fill in", code: [{ title: "Values", lang: "text", code: `API Key:   ${key}\nAPI Host:  ${origin}` }], text: "Cherry Studio adds /v1 itself. If requests fail, set the host to the /v1 address instead." },
      { title: "Add the models", text: 'Click "Manage" (or "+ Add") under Models and add the ones you want, then turn the provider on.', code: [{ title: "Model IDs", lang: "text", code: modelList.join("\n") || anyModel }] },
    ],
  });

  guides.push({
    id: "open-webui",
    label: "Open WebUI",
    category: "Desktop & chat apps",
    summary: "Self-hosted ChatGPT-style web UI.",
    steps: [
      { title: "Add a connection", text: "Admin Panel > Settings > Connections > OpenAI API > + (Add connection)." },
      { title: "Fill in and save", code: [{ title: "Values", lang: "text", code: `URL:  ${base}\nKey:  ${key}` }], text: "Open WebUI reads the model list from the key automatically." },
    ],
  });

  guides.push({
    id: "librechat",
    label: "LibreChat",
    category: "Desktop & chat apps",
    summary: "Self-hosted chat UI, as a custom endpoint.",
    steps: [
      {
        title: "Add the endpoint to librechat.yaml",
        code: [
          {
            title: "librechat.yaml",
            filename: "librechat.yaml",
            lang: "text",
            code: `endpoints:\n  custom:\n    - name: "${name}"\n      apiKey: "\${${envVar}}"\n      baseURL: "${base}"\n      models:\n        default: [${(modelList.length ? modelList : [anyModel]).map((m) => `"${m}"`).join(", ")}]\n        fetch: true\n      titleConvo: true\n      titleModel: "current_model"\n      modelDisplayLabel: "${name}"`,
          },
        ],
      },
      { title: "Add the key to LibreChat's .env and restart", code: [{ title: ".env", filename: ".env", lang: "bash", code: `${envVar}=${key}` }] },
    ],
  });

  guides.push({
    id: "chat-apps",
    label: "Chatbox / LobeChat / TypingMind / Msty / Jan",
    category: "Desktop & chat apps",
    summary: "Any chat app with a custom OpenAI-compatible provider.",
    steps: [
      { title: "Add a custom provider", text: 'In the app\'s settings, add a model provider of type "OpenAI API Compatible" / "Custom OpenAI" (the name differs per app).' },
      { title: "Fill in", code: [{ title: "Values", lang: "text", code: `API Host / Base URL:  ${base}\nAPI Key:              ${key}\nModels:               ${modelList.join(", ") || anyModel}` }] },
      { title: "Pick a model and chat", text: "If the app asks for the host without /v1, use the address without it." },
    ],
  });

  // ------------------------------------------------------------------------------------------------ SDKs & API
  guides.push({
    id: "python",
    label: "Python",
    category: "SDKs & API",
    summary: "OpenAI and Anthropic Python SDKs.",
    steps: [
      {
        title: "OpenAI SDK (every model of this key)",
        code: [{ title: "pip install openai", lang: "python", code: `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}", api_key="${key}")\n\nresp = client.chat.completions.create(\n    model="${anyModel}",\n    messages=[{"role": "user", "content": "Say hello in five words."}],\n)\nprint(resp.choices[0].message.content)` }],
      },
      {
        title: "Anthropic SDK",
        code: [{ title: "pip install anthropic", lang: "python", code: `import anthropic\n\nclient = anthropic.Anthropic(base_url="${origin}", api_key="${key}")  # the SDK adds /v1/messages\n\nmsg = client.messages.create(\n    model="${ex.claudeModels.length ? sonnet : anyModel}",\n    max_tokens=1024,\n    messages=[{"role": "user", "content": "Say hello in five words."}],\n)\nprint(msg.content[0].text)` }],
      },
      {
        title: "LangChain",
        code: [{ title: "pip install langchain-openai", lang: "python", code: `from langchain_openai import ChatOpenAI\n\nllm = ChatOpenAI(model="${anyModel}", base_url="${base}", api_key="${key}")\nprint(llm.invoke("Say hello in five words.").content)` }],
      },
    ],
  });

  guides.push({
    id: "node",
    label: "Node.js / TypeScript",
    category: "SDKs & API",
    summary: "OpenAI, Anthropic and Vercel AI SDKs.",
    steps: [
      {
        title: "OpenAI SDK (every model of this key)",
        code: [{ title: "npm install openai", lang: "javascript", code: `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${base}", apiKey: "${key}" });\n\nconst resp = await client.chat.completions.create({\n  model: "${anyModel}",\n  messages: [{ role: "user", content: "Say hello in five words." }],\n});\nconsole.log(resp.choices[0].message.content);` }],
      },
      {
        title: "Anthropic SDK",
        code: [{ title: "npm install @anthropic-ai/sdk", lang: "javascript", code: `import Anthropic from "@anthropic-ai/sdk";\n\nconst client = new Anthropic({ baseURL: "${origin}", apiKey: "${key}" }); // the SDK adds /v1/messages\n\nconst msg = await client.messages.create({\n  model: "${ex.claudeModels.length ? sonnet : anyModel}",\n  max_tokens: 1024,\n  messages: [{ role: "user", content: "Say hello in five words." }],\n});\nconsole.log(msg.content[0].type === "text" ? msg.content[0].text : msg.content);` }],
      },
      {
        title: "Vercel AI SDK",
        code: [{ title: "npm install ai @ai-sdk/openai", lang: "javascript", code: `import { createOpenAI } from "@ai-sdk/openai";\nimport { generateText } from "ai";\n\nconst provider = createOpenAI({ baseURL: "${base}", apiKey: "${key}" });\n\nconst { text } = await generateText({ model: provider("${anyModel}"), prompt: "Say hello in five words." });\nconsole.log(text);` }],
      },
    ],
  });

  guides.push({
    id: "curl",
    label: "curl / HTTP",
    category: "SDKs & API",
    summary: "Raw HTTP: OpenAI, Anthropic and Gemini formats.",
    steps: [
      {
        title: "OpenAI format",
        os: {
          unix: [{ title: "macOS / Linux", lang: "bash", code: `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${anyModel}", "messages": [{"role": "user", "content": "Say hello in five words."}]}'` }],
          windows: [{ title: "PowerShell", lang: "text", code: `Invoke-RestMethod -Method Post -Uri "${base}/chat/completions" \`\n  -Headers @{ Authorization = "Bearer ${key}" } -ContentType "application/json" \`\n  -Body '{"model": "${anyModel}", "messages": [{"role": "user", "content": "Say hello in five words."}]}'` }],
        },
      },
      {
        title: "Anthropic format",
        code: [{ title: "curl", lang: "bash", code: `curl ${base}/messages \\\n  -H "x-api-key: ${key}" \\\n  -H "anthropic-version: 2023-06-01" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${ex.claudeModels.length ? sonnet : anyModel}", "max_tokens": 1024, "messages": [{"role": "user", "content": "Say hello in five words."}]}'` }],
      },
      ...(ex.gemini
        ? [{ title: "Gemini format", code: [{ title: "curl", lang: "bash" as const, code: `curl "${origin}/v1beta/models/${ex.gemini}:generateContent" \\\n  -H "x-goog-api-key: ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"contents": [{"role": "user", "parts": [{"text": "Say hello in five words."}]}]}'` }] }]
        : []),
    ],
  });

  guides.push({
    id: "other",
    label: "Any other app",
    category: "SDKs & API",
    summary: "The values any OpenAI-, Anthropic- or Gemini-compatible client needs.",
    steps: [
      {
        title: "Use these values",
        code: [
          {
            title: "Settings",
            lang: "text",
            code: `OpenAI-compatible base URL:     ${base}\nAnthropic-compatible base URL:  ${origin}   (use ${base} if the app adds only /messages)\nGemini-compatible base URL:     ${origin}\nAPI key:                        ${key}\nModels:                         ${listText}`,
          },
        ],
      },
      { title: "If you get 401 \"invalid API key\" from OpenAI / Anthropic", text: "The app is still calling the official servers: check that its base URL / host setting is the one above." },
    ],
  });

  return guides;
}
