import Link from "next/link";
import { buildSnippets } from "@/components/customer/snippets";
import { Callout, C, CodeTabs, Endpoint, H2, P, SnippetTabs, Table, UL } from "./prose";
import { CodeBlock } from "@/components/marketing/code-block";

export interface DocCtx {
  appUrl: string;
  /** `${appUrl}/v1` */
  base: string;
  siteName: string;
  m: { chat: string; claude: string; gemini: string; image: string; embed: string };
}

const KEY = "$API_KEY";

export function quickstart(ctx: DocCtx) {
  const tabs = buildSnippets({ appUrl: ctx.appUrl, model: ctx.m.chat, claudeModel: ctx.m.claude, geminiModel: ctx.m.gemini, siteName: ctx.siteName });
  return (
    <>
      <P>
        {ctx.siteName} gives you one API key and one base URL for models from OpenAI, Anthropic, Google and more. It speaks the OpenAI, Anthropic and Gemini wire formats, so
        you can keep using the official SDKs and tools: change the base URL and the key, and you are done.
      </P>
      <H2>1. Create an account and a key</H2>
      <UL>
        <li>
          <Link className="text-primary underline-offset-4 hover:underline" href="/signup">
            Sign up
          </Link>{" "}
          and verify your email (keys do not work until your email is verified).
        </li>
        <li>
          Add balance on the <Link className="text-primary underline-offset-4 hover:underline" href="/dashboard/billing">Billing</Link> page. Usage is deducted from your prepaid balance.
        </li>
        <li>
          Create a key on the <Link className="text-primary underline-offset-4 hover:underline" href="/dashboard/keys">API Keys</Link> page. The full key is shown <strong>once</strong>; copy it somewhere safe.
        </li>
      </UL>
      <H2>2. Base URLs</H2>
      <Table
        head={["API", "Base URL"]}
        rows={[
          ["OpenAI-compatible", <C key="a">{ctx.base}</C>],
          ["Anthropic-compatible", <C key="b">{ctx.appUrl}</C>],
          ["Gemini-compatible", <C key="c">{ctx.appUrl}/v1beta</C>],
        ]}
      />
      <P>
        The Anthropic SDK appends <C>/v1/messages</C> itself, so give it the origin (<C>{ctx.appUrl}</C>) as its base URL.
      </P>
      <H2>3. Make a request</H2>
      <SnippetTabs tabs={tabs} only={["curl", "python", "node"]} />
      <Callout kind="tip" title="Which model should I use?">
        Browse <Link className="text-primary underline-offset-4 hover:underline" href="/pricing">Pricing</Link> for the live catalog, or call <C>GET /v1/models</C> with your key to see the models available to it.
      </Callout>
      <H2>Next steps</H2>
      <UL>
        <li><Link className="text-primary underline-offset-4 hover:underline" href="/docs/streaming">Streaming</Link> and <Link className="text-primary underline-offset-4 hover:underline" href="/docs/tools">tool calling</Link></li>
        <li><Link className="text-primary underline-offset-4 hover:underline" href="/docs/clients/codex-cli">Set up Codex CLI, Claude Code or OpenCode</Link></li>
        <li><Link className="text-primary underline-offset-4 hover:underline" href="/docs/errors">Error codes</Link> and <Link className="text-primary underline-offset-4 hover:underline" href="/docs/rate-limits">rate limits</Link></li>
      </UL>
    </>
  );
}

export function authentication(ctx: DocCtx) {
  return (
    <>
      <P>
        Every request must carry an API key that starts with <C>sk-pp-</C>. We accept the key in whichever place your SDK puts it, so official clients work without changes.
      </P>
      <Table
        head={["Format", "Header", "Example"]}
        rows={[
          ["OpenAI", <C key="1">Authorization</C>, <C key="1b">Authorization: Bearer sk-pp-...</C>],
          ["Anthropic", <C key="2">x-api-key</C>, <C key="2b">x-api-key: sk-pp-...</C>],
          ["Gemini", <C key="3">x-goog-api-key</C>, <C key="3b">x-goog-api-key: sk-pp-...</C>],
          ["Gemini (query)", <C key="4">?key=</C>, <C key="4b">?key=sk-pp-...</C>],
        ]}
      />
      <CodeBlock lang="bash" code={`curl ${ctx.base}/models -H "Authorization: Bearer ${KEY}"`} />
      <H2>Key settings</H2>
      <UL>
        <li><strong>Pool (group)</strong>: decides your price (a share of the official list price) and which models are reachable.</li>
        <li><strong>Allowed models</strong>: optionally restrict a key to specific models.</li>
        <li><strong>Limits</strong>: requests per minute, tokens per minute, max concurrent requests and a lifetime spend limit.</li>
        <li><strong>IP allowlist</strong>: exact IPs or CIDR ranges allowed to use the key.</li>
        <li><strong>Expiry</strong>: the key stops working after the date you set.</li>
      </UL>
      <Callout kind="warn" title="Keep keys secret">
        Never ship a key in browser or mobile code. If a key leaks, revoke it on the API Keys page and create a new one; revocation takes effect within seconds.
      </Callout>
      <P>
        Authentication failures return <C>401</C> (<C>invalid_api_key</C>, <C>key_disabled</C>, <C>key_expired</C>) or <C>403</C> (<C>ip_not_allowed</C>, <C>email_not_verified</C>, <C>account_suspended</C>). See{" "}
        <Link className="text-primary underline-offset-4 hover:underline" href="/docs/errors">error codes</Link>.
      </P>
    </>
  );
}

export function openaiChat(ctx: DocCtx) {
  return (
    <>
      <Endpoint method="POST" path="/v1/chat/completions" />
      <P>The standard OpenAI Chat Completions API. Any model in the catalog can be used, regardless of vendor.</P>
      <CodeTabs
        tabs={[
          {
            id: "curl",
            label: "curl",
            lang: "bash",
            code: `curl ${ctx.base}/chat/completions \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${ctx.m.chat}",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Explain recursion in one sentence."}
    ],
    "temperature": 0.7,
    "max_tokens": 200
  }'`,
          },
          {
            id: "python",
            label: "Python",
            lang: "python",
            code: `from openai import OpenAI
client = OpenAI(base_url="${ctx.base}", api_key="sk-pp-...")
r = client.chat.completions.create(
    model="${ctx.m.chat}",
    messages=[{"role": "user", "content": "Explain recursion in one sentence."}],
)
print(r.choices[0].message.content, r.usage)`,
          },
        ]}
      />
      <H2>Supported parameters</H2>
      <P>
        <C>messages</C>, <C>temperature</C>, <C>top_p</C>, <C>max_tokens</C> / <C>max_completion_tokens</C>, <C>stop</C>, <C>stream</C>, <C>tools</C>, <C>tool_choice</C>, <C>response_format</C>,{" "}
        <C>reasoning_effort</C>, <C>seed</C> and image inputs (<C>image_url</C> content parts) are forwarded when the selected model supports them. Unsupported parameters are handled
        the way the underlying provider handles them.
      </P>
      <H2>Usage</H2>
      <P>
        Responses include a <C>usage</C> object (prompt, completion and, where available, cached and reasoning tokens). With <C>stream: true</C>, usage is always collected on our
        side for billing; pass <C>stream_options: {`{"include_usage": true}`}</C> to receive it in the final chunk.
      </P>
      <P>Models from Anthropic or Google also work on this endpoint; we translate the request automatically.</P>
    </>
  );
}

export function openaiResponses(ctx: DocCtx) {
  return (
    <>
      <Endpoint method="POST" path="/v1/responses" />
      <P>
        The OpenAI Responses API, used by Codex CLI and newer OpenAI SDK versions. Retrieve, delete, cancel and list input items for a response with the matching{" "}
        <C>GET/DELETE /v1/responses/{"{id}"}</C>, <C>POST /v1/responses/{"{id}"}/cancel</C> and <C>GET /v1/responses/{"{id}"}/input_items</C> endpoints.
      </P>
      <CodeBlock
        lang="bash"
        code={`curl ${ctx.base}/responses \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${ctx.m.chat}",
    "input": "Write a haiku about proxies.",
    "stream": false
  }'`}
      />
      <Callout kind="info">
        Responses endpoints are available for models that expose the <C>responses</C> capability. Stored responses are only retrievable for a limited time; otherwise you get a 404.
      </Callout>
    </>
  );
}

export function openaiCompletions(ctx: DocCtx) {
  return (
    <>
      <Endpoint method="POST" path="/v1/completions" />
      <P>Legacy text completions for models with the <C>completions</C> capability.</P>
      <CodeBlock
        lang="bash"
        code={`curl ${ctx.base}/completions \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${ctx.m.chat}", "prompt": "Once upon a time", "max_tokens": 50}'`}
      />
    </>
  );
}

export function openaiEmbeddings(ctx: DocCtx) {
  return (
    <>
      <Endpoint method="POST" path="/v1/embeddings" />
      <CodeBlock
        lang="bash"
        code={`curl ${ctx.base}/embeddings \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${ctx.m.embed}", "input": ["first text", "second text"]}'`}
      />
      <P>
        Billing is by input tokens. Pass <C>dimensions</C> and <C>encoding_format</C> where the model supports them.
      </P>
    </>
  );
}

export function openaiImages(ctx: DocCtx) {
  return (
    <>
      <Endpoint method="POST" path="/v1/images/generations" />
      <Endpoint method="POST" path="/v1/images/edits" />
      <Endpoint method="POST" path="/v1/images/variations" />
      <CodeBlock
        lang="bash"
        code={`curl ${ctx.base}/images/generations \\
  -H "Authorization: Bearer ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${ctx.m.image}", "prompt": "A lighthouse at dusk, oil painting", "size": "1024x1024", "n": 1}'`}
      />
      <P>
        Edits and variations take <C>multipart/form-data</C>, as in the OpenAI API. Image models are usually billed per generated image; the exact price is listed on the Pricing page. See also the{" "}
        <Link className="text-primary underline-offset-4 hover:underline" href="/docs/images">image generation guide</Link>.
      </P>
    </>
  );
}

export function openaiAudio(ctx: DocCtx) {
  return (
    <>
      <Endpoint method="POST" path="/v1/audio/speech" />
      <Endpoint method="POST" path="/v1/audio/transcriptions" />
      <Endpoint method="POST" path="/v1/audio/translations" />
      <P>Text-to-speech returns binary audio; transcription and translation take a multipart file upload. Availability depends on the models in the catalog (look for the Speech / Transcription capabilities).</P>
      <CodeBlock
        lang="bash"
        code={`# Speech
curl ${ctx.base}/audio/speech \\
  -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \\
  -d '{"model": "MODEL_ID", "input": "Hello there", "voice": "alloy"}' --output hello.mp3

# Transcription
curl ${ctx.base}/audio/transcriptions \\
  -H "Authorization: Bearer ${KEY}" \\
  -F model=MODEL_ID -F file=@audio.mp3`}
      />
    </>
  );
}

export function openaiModerations(ctx: DocCtx) {
  return (
    <>
      <Endpoint method="POST" path="/v1/moderations" />
      <CodeBlock
        lang="bash"
        code={`curl ${ctx.base}/moderations \\
  -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \\
  -d '{"model": "MODEL_ID", "input": "text to classify"}'`}
      />
    </>
  );
}

export function openaiModels(ctx: DocCtx) {
  return (
    <>
      <Endpoint method="GET" path="/v1/models" />
      <Endpoint method="GET" path="/v1/models/{id}" />
      <P>
        Lists the models your key can use (respecting its pool and allowed-models list). The response uses the OpenAI shape by default and the Anthropic shape when you send an{" "}
        <C>anthropic-version</C> header. <C>GET /v1beta/models</C> returns the Gemini shape.
      </P>
      <CodeBlock lang="bash" code={`curl ${ctx.base}/models -H "Authorization: Bearer ${KEY}"`} />
      <P>
        Each model includes its context length, maximum output and your live prices (<C>pricing</C> and <C>x_pricing</C>); see{" "}
        <Link className="text-primary underline-offset-4 hover:underline" href="/docs/pricing-api">Pricing API</Link>.
      </P>
    </>
  );
}

export function anthropicMessages(ctx: DocCtx) {
  return (
    <>
      <Endpoint method="POST" path="/v1/messages" />
      <P>The Anthropic Messages API. Use the official Anthropic SDKs with <C>base_url</C> set to <C>{ctx.appUrl}</C>.</P>
      <CodeTabs
        tabs={[
          {
            id: "curl",
            label: "curl",
            lang: "bash",
            code: `curl ${ctx.base}/messages \\
  -H "x-api-key: ${KEY}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${ctx.m.claude}",
    "max_tokens": 1024,
    "system": "You are concise.",
    "messages": [{"role": "user", "content": "What is a proxy?"}]
  }'`,
          },
          {
            id: "python",
            label: "Python",
            lang: "python",
            code: `import anthropic
client = anthropic.Anthropic(base_url="${ctx.appUrl}", api_key="sk-pp-...")
msg = client.messages.create(
    model="${ctx.m.claude}",
    max_tokens=1024,
    messages=[{"role": "user", "content": "What is a proxy?"}],
)
print(msg.content[0].text)`,
          },
        ]}
      />
      <P>
        System prompts, multi-turn conversations, images, tools (<C>tool_use</C> / <C>tool_result</C>), prompt caching (<C>cache_control</C>), extended thinking and streaming are supported.
        Non-Anthropic models can also be called on this endpoint; requests are translated for you.
      </P>
    </>
  );
}

export function anthropicCountTokens(ctx: DocCtx) {
  return (
    <>
      <Endpoint method="POST" path="/v1/messages/count_tokens" />
      <CodeBlock
        lang="bash"
        code={`curl ${ctx.base}/messages/count_tokens \\
  -H "x-api-key: ${KEY}" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \\
  -d '{"model": "${ctx.m.claude}", "messages": [{"role": "user", "content": "Hello"}]}'`}
      />
      <P>Returns <C>{`{"input_tokens": N}`}</C>. Counting tokens is free.</P>
    </>
  );
}

export function anthropicHeaders() {
  return (
    <>
      <Table
        head={["Header", "Behavior"]}
        rows={[
          [<C key="1">x-api-key</C>, "Your sk-pp- key. Authorization: Bearer also works."],
          [<C key="2">anthropic-version</C>, "Passed through; defaults to 2023-06-01 when omitted. Sending it also makes /v1/models respond in Anthropic's shape."],
          [<C key="3">anthropic-beta</C>, "Passed through (for example for extended thinking or 1M-context betas)."],
          [<C key="4">x-request-id</C>, "Returned on every response; quote it when contacting support."],
        ]}
      />
      <P>Errors use Anthropic&apos;s shape: <C>{`{"type":"error","error":{"type":"...","message":"..."}}`}</C>. Rate limits include <C>retry-after</C>, so the SDK&apos;s automatic retries work.</P>
    </>
  );
}

export function gemini(ctx: DocCtx) {
  return (
    <>
      <Endpoint method="POST" path="/v1beta/models/{model}:generateContent" />
      <Endpoint method="POST" path="/v1beta/models/{model}:streamGenerateContent?alt=sse" />
      <Endpoint method="POST" path="/v1beta/models/{model}:countTokens" />
      <Endpoint method="POST" path="/v1beta/models/{model}:embedContent" />
      <Endpoint method="POST" path="/v1beta/models/{model}:batchEmbedContents" />
      <CodeBlock
        lang="bash"
        code={`curl "${ctx.appUrl}/v1beta/models/${ctx.m.gemini}:generateContent" \\
  -H "x-goog-api-key: ${KEY}" \\
  -H "Content-Type: application/json" \\
  -d '{"contents": [{"role": "user", "parts": [{"text": "Hello!"}]}]}'`}
      />
      <CodeBlock
        lang="python"
        title="google-genai SDK"
        code={`from google import genai
client = genai.Client(api_key="sk-pp-...", http_options={"base_url": "${ctx.appUrl}"})
r = client.models.generate_content(model="${ctx.m.gemini}", contents="Hello!")
print(r.text)`}
      />
      <P>The model comes from the URL path, as in Google&apos;s API. Streaming uses <C>?alt=sse</C>. Errors use Google&apos;s <C>{`{"error":{"code","message","status"}}`}</C> shape.</P>
      <Callout kind="info">Native Gemini format is available for models that support it. Other models can be reached from the OpenAI or Anthropic endpoints.</Callout>
    </>
  );
}
