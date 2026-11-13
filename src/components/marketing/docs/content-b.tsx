import Link from "next/link";
import { buildSnippets } from "@/components/customer/snippets";
import { CodeBlock } from "@/components/marketing/code-block";
import { ERROR_CODES } from "@/server/customer/error-codes";
import { Callout, C, CodeTabs, H2, H3, P, SnippetTabs, Table, UL } from "./prose";
import type { DocCtx } from "./content-a";

const KEY = "$API_KEY";
const A = "text-primary underline-offset-4 hover:underline";

export function streaming(ctx: DocCtx) {
  return (
    <>
      <P>
        Set <C>stream: true</C> and the response arrives as server-sent events (<C>text/event-stream</C>) in the same shape as the official API for the endpoint you called. Bytes are
        passed through as they arrive; there is no buffering.
      </P>
      <CodeTabs
        tabs={[
          {
            id: "curl",
            label: "curl",
            lang: "bash",
            code: `curl -N ${ctx.base}/chat/completions \\
  -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \\
  -d '{"model": "${ctx.m.chat}", "stream": true, "stream_options": {"include_usage": true},
       "messages": [{"role": "user", "content": "Count to five."}]}'`,
          },
          {
            id: "python",
            label: "Python",
            lang: "python",
            code: `stream = client.chat.completions.create(
    model="${ctx.m.chat}",
    messages=[{"role": "user", "content": "Count to five."}],
    stream=True,
    stream_options={"include_usage": True},
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)`,
          },
          {
            id: "anthropic",
            label: "Anthropic SDK",
            lang: "python",
            code: `with client.messages.stream(model="${ctx.m.claude}", max_tokens=512,
        messages=[{"role": "user", "content": "Count to five."}]) as s:
    for text in s.text_stream:
        print(text, end="", flush=True)`,
          },
        ]}
      />
      <H2>Billing and disconnects</H2>
      <P>
        Usage is read from the final event of the stream. If the client disconnects early, the request is cancelled and billed for the tokens received so far (estimated when the
        provider has not reported usage yet). Errors before the first byte are returned as normal JSON errors with the proper HTTP status; once streaming has started, failures are sent
        as an error event, also when the model&apos;s connection breaks mid-answer (code <C>upstream_error</C>, with the request id in the message). A request that fails on the model&apos;s side after it started (the stream drops, or ends with an error event) is not charged.
      </P>
      <Callout kind="tip">Disable proxy buffering in your own infrastructure (for example <C>proxy_buffering off</C> in nginx) so tokens reach users immediately.</Callout>
    </>
  );
}

export function tools(ctx: DocCtx) {
  return (
    <>
      <P>
        Tool (function) calling works in every format and across vendors: define tools, let the model request calls, run them yourself and send the results back.
      </P>
      <CodeBlock
        lang="python"
        title="OpenAI format"
        code={`tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}]
messages = [{"role": "user", "content": "Weather in Paris?"}]
r = client.chat.completions.create(model="${ctx.m.chat}", messages=messages, tools=tools)
call = r.choices[0].message.tool_calls[0]
messages.append(r.choices[0].message)
messages.append({"role": "tool", "tool_call_id": call.id, "content": '{"temp_c": 18}'})
final = client.chat.completions.create(model="${ctx.m.chat}", messages=messages, tools=tools)
print(final.choices[0].message.content)`}
      />
      <CodeBlock
        lang="python"
        title="Anthropic format"
        code={`tools = [{"name": "get_weather", "description": "Get the weather",
          "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}]
r = client.messages.create(model="${ctx.m.claude}", max_tokens=1024, tools=tools,
                           messages=[{"role": "user", "content": "Weather in Paris?"}])
tool_use = next(b for b in r.content if b.type == "tool_use")
# run the tool, then reply with a tool_result block in a user message`}
      />
      <P>
        Use <C>tool_choice</C> to force or forbid calls. Streamed tool calls arrive as incremental argument deltas in the format you requested. Only models with the <strong>Tools</strong> capability
        accept tools.
      </P>
    </>
  );
}

export function imagesGuide(ctx: DocCtx) {
  return (
    <>
      <P>Generate images with models that have the <strong>Images</strong> capability. You can try them without writing code in the dashboard&apos;s Image Studio (Playground &rarr; Images).</P>
      <CodeTabs
        tabs={[
          {
            id: "python",
            label: "Python",
            lang: "python",
            code: `import base64
r = client.images.generate(model="${ctx.m.image}", prompt="A red fox in snow, watercolor", size="1024x1024", n=1)
img = r.data[0]
data = base64.b64decode(img.b64_json) if img.b64_json else None
print(img.url or "base64 image of", len(data or b""), "bytes")`,
          },
          {
            id: "curl",
            label: "curl",
            lang: "bash",
            code: `curl ${ctx.base}/images/generations -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \\
  -d '{"model": "${ctx.m.image}", "prompt": "A red fox in snow, watercolor", "size": "1024x1024"}'`,
          },
        ]}
      />
      <H2>Request fields</H2>
      <Table
        head={["Field", "Meaning"]}
        rows={[
          [<C key="n">n</C>, "Number of images (1-10). Billed per image actually returned."],
          [<C key="s">size</C>, <>e.g. <C key="s1">1024x1024</C>. Mapped to each model&apos;s own size / aspect-ratio parameter.</>],
          [<C key="r">response_format</C>, <><C key="r1">url</C> (default for FLUX-style models) or <C key="r2">b64_json</C> (we download and encode the image for you).</>],
          [<C key="sd">seed</C>, "Fixed seed for reproducible results where the model supports it."],
          [<C key="e">extra_input</C>, "Object of model-specific parameters passed through unchanged (e.g. guidance_scale, num_inference_steps, go_fast)."],
        ]}
      />
      <CodeBlock
        lang="bash"
        code={`curl ${ctx.base}/images/generations -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \\
  -d '{"model": "${ctx.m.image}", "prompt": "A red fox in snow", "n": 2, "size": "1024x1024", "seed": 7,
       "response_format": "b64_json", "extra_input": {"guidance_scale": 3.5}}'`}
      />
      <Callout kind="info">
        FLUX models served through fal.ai or Replicate are exposed through this same endpoint. Only <C>/v1/images/generations</C> is available for them (no edits or variations).
      </Callout>
      <H2>Pricing</H2>
      <P>Image models are billed per generated image (shown on the Pricing page) or, for token-billed models, by the tokens the model reports, at your pool&apos;s price. Each request shows its exact cost in your Logs.</P>
    </>
  );
}

export function videosGuide(ctx: DocCtx) {
  return (
    <>
      <P>
        Video generation follows the OpenAI videos API: you create a job, poll it until it is <C>completed</C>, then download the file. Use a model with the <strong>Video</strong> capability from{" "}
        <C>GET /v1/models</C>.
      </P>
      <Table
        head={["Endpoint", "Purpose"]}
        rows={[
          [<C key="a">POST /v1/videos</C>, <>Create a job. JSON or <C key="a1">multipart/form-data</C> with an <C key="a2">input_reference</C> image. Fields: <C key="a3">model</C>, <C key="a4">prompt</C>, <C key="a5">seconds</C>, <C key="a6">size</C>.</>],
          [<C key="b">GET /v1/videos/{"{id}"}</C>, <>Status: <C key="b1">queued</C>, <C key="b2">in_progress</C>, <C key="b3">completed</C> or <C key="b4">failed</C>, with <C key="b5">progress</C>.</>],
          [<C key="c">GET /v1/videos/{"{id}"}/content</C>, <>Download the result (<C key="c1">video/mp4</C>). <C key="c2">?variant=thumbnail</C> or <C key="c3">spritesheet</C> where supported. Range requests work.</>],
          [<C key="d">GET /v1/videos</C>, "List your own videos (limit, after, order)."],
          [<C key="e">DELETE /v1/videos/{"{id}"}</C>, "Delete a video."],
        ]}
      />
      <CodeBlock
        lang="bash"
        code={`# 1. create
curl ${ctx.base}/videos -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" \\
  -d '{"model": "<video-model>", "prompt": "A calm ocean wave at sunrise", "seconds": "4", "size": "720x1280"}'
# 2. poll until "status": "completed"
curl ${ctx.base}/videos/video_... -H "Authorization: Bearer ${KEY}"
# 3. download
curl ${ctx.base}/videos/video_.../content -H "Authorization: Bearer ${KEY}" -o out.mp4`}
      />
      <H2>Billing</H2>
      <UL>
        <li>The job is charged <strong>when it is created</strong>: requested seconds times your per-second price for the model.</li>
        <li>If a job later ends as <C>failed</C>, the full charge is refunded to your balance automatically (shown as a Refund in your ledger), exactly once.</li>
        <li>Polling and downloading are free. Videos are only visible to the account that created them; any other key gets <C>404</C>.</li>
      </UL>
    </>
  );
}

export function batchesGuide(ctx: DocCtx) {
  return (
    <>
      <P>
        Both batch APIs are supported with the official SDKs: Anthropic Message Batches and the OpenAI Batch API. A batch runs asynchronously (usually within minutes,
        at most 24 hours) and is billed at the <strong>batch price: 50% off input and output tokens</strong> (server tools such as web search are billed at their normal price).
      </P>
      <H2>Anthropic Message Batches</H2>
      <Table
        head={["Endpoint", "Purpose"]}
        rows={[
          [<C key="a">POST /v1/messages/batches</C>, <>Create a batch: <C key="a1">{"{\"requests\": [{\"custom_id\", \"params\"}]}"}</C>, where <C key="a2">params</C> is a normal Messages request.</>],
          [<C key="b">GET /v1/messages/batches/{"{id}"}</C>, <>Status (<C key="b1">in_progress</C>, <C key="b2">canceling</C>, <C key="b3">ended</C>) and request counts.</>],
          [<C key="c">GET /v1/messages/batches/{"{id}"}/results</C>, "Results as JSONL, one line per request, once the batch has ended."],
          [<C key="d">POST /v1/messages/batches/{"{id}"}/cancel</C>, "Cancel; requests that have not run yet end as canceled (not billed)."],
          [<C key="e">GET /v1/messages/batches</C>, "List your own batches (limit, before_id, after_id)."],
          [<C key="f">DELETE /v1/messages/batches/{"{id}"}</C>, "Delete an ended batch."],
        ]}
      />
      <CodeBlock
        lang="bash"
        code={`curl ${ctx.base}/messages/batches -H "x-api-key: ${KEY}" -H "anthropic-version: 2023-06-01" -H "Content-Type: application/json" \\
  -d '{"requests": [{"custom_id": "q1", "params": {"model": "${ctx.m.claude}", "max_tokens": 1024, "messages": [{"role": "user", "content": "Hello"}]}}]}'`}
      />
      <H2>OpenAI Batch API</H2>
      <P>
        Upload a JSONL input file with <C>purpose=batch</C> through <C>POST /v1/files</C>, then create the batch with <C>POST /v1/batches</C> (<C>input_file_id</C>, <C>endpoint</C>,{" "}
        <C>completion_window: &quot;24h&quot;</C>). Supported endpoints: <C>/v1/chat/completions</C>, <C>/v1/responses</C>, <C>/v1/embeddings</C>, <C>/v1/completions</C>,{" "}
        <C>/v1/moderations</C>. Poll <C>GET /v1/batches/{"{id}"}</C>; when it is <C>completed</C>, download <C>output_file_id</C> (and <C>error_file_id</C>) with{" "}
        <C>GET /v1/files/{"{id}"}/content</C>. <C>POST /v1/batches/{"{id}"}/cancel</C> and <C>GET /v1/batches</C> work as usual.
      </P>
      <H2>Rules</H2>
      <UL>
        <li>Every request in a batch is checked when you create it: an unknown model, a model your key may not use, or a model without batch support rejects the <strong>whole</strong> batch, and the error names the <C>custom_id</C>.</li>
        <li>All models of one batch must be available together; if they are not, split the batch by model.</li>
        <li>When you create a batch, your balance must cover its worst case (every request at its <C>max_tokens</C>, batch price). That amount is held until the results are billed, then released. If the balance is too low you get <C>402 insufficient_balance</C>.</li>
        <li>Each succeeded result is billed exactly once. Errored, canceled and expired requests are free. Results show up in your request logs with the batch id.</li>
        <li>Batches and their result files are only visible to the account that created them. Any other key gets <C>404</C>.</li>
      </UL>
    </>
  );
}

export function rateLimits() {
  return (
    <>
      <P>
        We behave like a native provider: when you exceed a limit you get an HTTP <C>429</C> in your client&apos;s native error shape with a <C>retry-after</C> header, so the official
        SDKs retry automatically.
      </P>
      <H2>Limits you control</H2>
      <UL>
        <li><strong>Requests per minute</strong> and <strong>tokens per minute</strong> per key, set on the API Keys page.</li>
        <li><strong>Max concurrency</strong> per key: the number of requests in flight at the same time (a streaming request holds its slot until the stream ends).</li>
        <li>Pool and account level limits set by the operator.</li>
      </UL>
      <H2>Concurrency slots</H2>
      <P>
        Each request takes a concurrency slot for as long as it runs. If all of your slots are in use the next request is rejected immediately with <C>429 rate_limited</C> and{" "}
        <C>retry-after: 1</C>. Lower your client&apos;s parallelism or ask for a higher limit.
      </P>
      <H2>Queueing under load</H2>
      <P>
        When capacity is temporarily saturated we hold your request in a short queue (up to about 20 seconds) instead of failing it. If capacity is still not available you get{" "}
        <C>429 no_capacity</C> with a <C>retry-after</C> hint. Temporary 429s and 5xx errors are retried transparently before they ever reach you: a 502, 503 or 504,
        or a connection that fails before any output, is retried for up to about 3 minutes. An error that does reach you has been failing for a while, so back off rather than
        retrying in a tight loop.
      </P>
      <H2>Handling 429s</H2>
      <CodeBlock
        lang="python"
        code={`import time, random
for attempt in range(6):
    try:
        return client.chat.completions.create(...)
    except openai.RateLimitError as e:
        wait = float(e.response.headers.get("retry-after", 2 ** attempt))
        time.sleep(wait + random.random() * 0.5)`}
      />
      <Callout kind="info">The official OpenAI and Anthropic SDKs already do this for you (<C>max_retries</C>).</Callout>
    </>
  );
}

export function billing(ctx: DocCtx) {
  return (
    <>
      <P>{`Billing is prepaid pay-as-you-go: each request deducts its exact cost from your balance. There is no subscription or minimum spend.`}</P>
      <H2>How a request is priced</H2>
      <CodeBlock
        lang="text"
        code={`price = ( uncached_input x input_price
        + cached_input   x cached_price
        + output (incl. reasoning) x output_price ) / 1,000,000
        x your pool's share of the official price
        + per-image / per-request charges`}
      />
      <UL>
        <li><strong>Pools</strong> set your price as a share of the official list price (for example 50% of official). Choose a pool per key when creating it.</li>
        <li><strong>Cached tokens</strong> are cheaper than normal input on models that support prompt caching.</li>
        <li><strong>Long-context</strong> requests above a model&apos;s threshold may carry a surcharge, noted on the Pricing page.</li>
        <li>Failed requests are not charged: 4xx/5xx errors, and streams that the model&apos;s side drops or ends with an error before they complete.</li>
      </UL>
      <H2>Adding balance</H2>
      {ctx.customerBilling ? (
        <UL>
          <li>Top up any amount by card from the <Link className={A} href="/dashboard/billing">Billing</Link> page.</li>
          <li>Enable <strong>auto-recharge</strong> to top up automatically when your balance drops below a threshold.</li>
          <li>Redeem codes are credited instantly.</li>
          <li>When the balance is exhausted, requests fail with <C>402 insufficient_balance</C> until you add funds.</li>
        </UL>
      ) : (
        <UL>
          <li>Your balance is managed by your administrator: ask them to top it up. You can see it at any time on your dashboard.</li>
          <li>When the balance is exhausted, requests fail with <C>402 insufficient_balance</C> until it is topped up.</li>
        </UL>
      )}
      <H2>Spend controls</H2>
      <P>Set a lifetime <strong>spend limit per key</strong> and a monthly spend limit for your account to cap exposure. Reaching a limit returns <C>402 spend_limit_reached</C>.</P>
      <P>See your spend by model, key and endpoint on the Usage page, and every request in Logs.</P>
      <H2>Prices from the API</H2>
      <P>Current prices are machine-readable: see <Link className={A} href="/docs/pricing-api">Pricing API</Link> to keep your own cost tables in sync automatically.</P>
    </>
  );
}

export function errors() {
  return (
    <>
      <P>
        Every response carries an <C>x-request-id</C> header (also visible in your Logs). Errors always use the error shape of the endpoint you called, with a stable machine-readable code.
      </P>
      <H2>Error shapes</H2>
      <CodeBlock
        lang="json"
        title="OpenAI-compatible endpoints"
        code={`{ "error": { "message": "Insufficient balance. Add credit to continue.", "type": "billing_error", "code": "insufficient_balance", "param": null } }`}
      />
      <CodeBlock
        lang="json"
        title="Anthropic-compatible endpoints"
        code={`{ "type": "error", "error": { "type": "rate_limit_error", "message": "Too many concurrent requests" } }`}
      />
      <CodeBlock
        lang="json"
        title="Gemini-compatible endpoints"
        code={`{ "error": { "code": 429, "message": "Too many concurrent requests", "status": "RESOURCE_EXHAUSTED" } }`}
      />
      <H2>Error codes</H2>
      <Table
        head={["Code", "HTTP", "Meaning", "How to fix"]}
        rows={ERROR_CODES.map((e) => [
          <code key={e.code} id={e.code} className="scroll-mt-24 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
            {e.code}
          </code>,
          <span key="h" className="tabular-nums">{e.http}</span>,
          e.meaning,
          e.fix,
        ])}
      />
      <Callout kind="tip">
        Retry <C>429</C>, <C>500</C>, <C>502</C>, <C>503</C> and <C>504</C> with exponential backoff and honour <C>retry-after</C>; after a few failed retries of a <C>503</C>, tell the user the
        service is temporarily unavailable instead of retrying forever. Do not retry <C>400</C>, <C>401</C>, <C>402</C>, <C>403</C> or <C>404</C> without changing something first.
        Every response carries an <C>x-request-id</C>: include it when contacting support.
      </Callout>
    </>
  );
}

function clientPage(ctx: DocCtx, id: string, intro: React.ReactNode, extra?: React.ReactNode) {
  const tabs = buildSnippets({ appUrl: ctx.appUrl, model: ctx.m.chat, claudeModel: ctx.m.claude, geminiModel: ctx.m.gemini, siteName: ctx.siteName });
  return (
    <>
      {intro}
      <SnippetTabs tabs={tabs} only={[id]} />
      {extra}
    </>
  );
}

export const codexCli = (ctx: DocCtx) =>
  clientPage(
    ctx,
    "codex",
    <P>Codex CLI talks to the OpenAI Responses API. Add a custom provider that points at {ctx.siteName} and export your key.</P>,
    <Callout kind="tip">Run <C>codex</C> in a new shell after exporting the variable. Each request shows up in your Logs with its cost.</Callout>,
  );

export const claudeCode = (ctx: DocCtx) =>
  clientPage(
    ctx,
    "claude-code",
    <P>Claude Code uses the Anthropic Messages API. Point it at {ctx.siteName} with two environment variables.</P>,
    <Callout kind="info">Do not add <C>/v1</C> to <C>ANTHROPIC_BASE_URL</C>; Claude Code adds the path itself. Use <C>ANTHROPIC_AUTH_TOKEN</C> (not <C>ANTHROPIC_API_KEY</C>) for a custom gateway key.</Callout>,
  );

export const opencode = (ctx: DocCtx) =>
  clientPage(ctx, "opencode", <P>OpenCode supports OpenAI-compatible providers. Add {ctx.siteName} to your <C>opencode.json</C> and list the models you want in the picker.</P>);

export const cursor = (ctx: DocCtx) =>
  clientPage(
    ctx,
    "other",
    <P>Any tool that lets you override the OpenAI base URL works with {ctx.siteName}: Cursor, Continue, Cline, Aider, LangChain, LlamaIndex, n8n and more.</P>,
    <>
      <H3>Aider</H3>
      <CodeBlock lang="bash" code={`export OPENAI_API_BASE=${ctx.base}\nexport OPENAI_API_KEY=sk-pp-YOUR_API_KEY\naider --model openai/${ctx.m.chat}`} />
    </>,
  );

export const pythonClient = (ctx: DocCtx) =>
  clientPage(ctx, "python", <P>Use the official OpenAI and Anthropic Python SDKs by overriding the base URL.</P>);

export const nodeClient = (ctx: DocCtx) =>
  clientPage(ctx, "node", <P>Use the official OpenAI Node SDK (also works in Bun, Deno and edge runtimes).</P>);

export function pricingApi(ctx: DocCtx) {
  const KEY = "$API_KEY";
  return (
    <>
      <P>
        Every price is available from the API, so you can keep your own price tables, cost estimates and budgets in sync automatically instead of copying numbers from the Pricing page.
        Prices are in US dollars and change only when the catalog changes; polling every few minutes is plenty.
      </P>
      <Table
        head={["Endpoint", "Auth", "Use it for"]}
        rows={[
          [<C key="a">GET /v1/models</C>, "API key", "The models your key can use, with your prices next to the official list price."],
          [<C key="b">GET /v1/models/{"{id}"}</C>, "API key", "The same fields for one model."],
          [<C key="c">GET /v1/model/info</C>, "API key", "LiteLLM-compatible cost per token, for LiteLLM, Langfuse and other cost trackers."],
          [<C key="d">GET /api/pricing</C>, "none, or API key", "The price list (default pool, or ?group=<pool>). Cached for 60 s, CORS enabled. When the operator makes pricing private it needs your API key, and then shows your own prices."],
        ]}
      />
      <H2>Your prices: GET /v1/models</H2>
      <CodeBlock lang="bash" code={`curl ${ctx.base}/models -H "Authorization: Bearer ${KEY}"`} />
      <P>
        Each model carries two price blocks. <C>pricing</C> uses the OpenRouter convention (decimal strings, US dollars per single token), so tools that read OpenRouter catalogs work unchanged.{" "}
        <C>x_pricing</C> gives US dollars per million tokens, your price next to the official one, the saving, and per-call tool prices.
      </P>
      <CodeBlock
        lang="json"
        title={`GET /v1/models/${ctx.m.chat} (abridged)`}
        code={`{
  "id": "${ctx.m.chat}",
  "object": "model",
  "context_length": 1000000,
  "pricing": {
    "prompt": "0.00001",          // USD per input token
    "completion": "0.00005",      // USD per output token (reasoning included)
    "input_cache_read": "0.000001",
    "input_cache_write": "0",
    "request": "0",
    "image": "0"
  },
  "top_provider": { "context_length": 1000000, "max_completion_tokens": 128000 },
  "x_pricing": {
    "unit": "usd_per_1m",
    "currency": "USD",
    "yours":    { "input": 10, "output": 50, "cached_input": 1 },
    "official": { "input": 10, "output": 50, "cached_input": 1 },
    "savings_pct": { "input": 0, "output": 0, "cached_input": 0 },
    "units": { "input": "usd_per_1m_tokens", "output": "usd_per_1m_tokens", "cached_input": "usd_per_1m_tokens" },
    "tools": { "web_search_call": { "yours": 0.01, "official": 0.01, "savings_pct": 0 } }
  }
}`}
      />
      <Callout kind="info">
        <C>yours</C> is exactly what you are charged: your key&apos;s pool and account pricing are already applied. Image, audio and video models use other units
        (<C>usd_per_image</C>, <C>usd_per_second</C>, <C>usd_per_minute</C>, ...), named in <C>x_pricing.units</C>.
      </Callout>
      <H2>LiteLLM format: GET /v1/model/info</H2>
      <CodeBlock lang="bash" code={`curl ${ctx.base}/model/info -H "Authorization: Bearer ${KEY}"`} />
      <CodeBlock
        lang="json"
        code={`{ "data": [ {
  "model_name": "${ctx.m.chat}",
  "model_info": {
    "input_cost_per_token": 1e-05,
    "output_cost_per_token": 5e-05,
    "cache_read_input_token_cost": 1e-06,
    "max_input_tokens": 1000000,
    "max_output_tokens": 128000,
    "mode": "chat",
    "supports_function_calling": true,
    "supports_vision": true,
    "supports_reasoning": true
  }
} ] }`}
      />
      <H2>Price list: GET /api/pricing</H2>
      <CodeBlock lang="bash" code={`curl ${ctx.appUrl}/api/pricing
curl "${ctx.appUrl}/api/pricing?group=pro"   # a public pool
curl ${ctx.appUrl}/api/pricing -H "Authorization: Bearer $PP_API_KEY"   # your own prices (works when pricing is private)`} />
      <P>
        No key needed, CORS <C>*</C>, cached for 60 seconds. The document lists the public pools (<C>groups</C>), the units, and per model the <C>yours</C> / <C>official</C> /{" "}
        <C>savings_pct</C> prices (US dollars per million tokens for text models). If the operator has made pricing private, it answers <C>401 pricing_private</C> without a key; send your
        API key the same way as on the API (<C>Authorization: Bearer</C>, <C>x-api-key</C> or <C>?key=</C>) and you get your own prices: your pool, your
        account pricing and your key&apos;s model allow-list, never cached by shared caches. A wrong, disabled or expired key is rejected with the usual{" "}
        <C>401</C>.
      </P>
      <H2>Keeping prices in sync</H2>
      <CodeTabs
        tabs={[
          {
            id: "node",
            label: "Node.js",
            lang: "ts",
            code: `// refresh every 10 minutes; cost of one request from the usage in its response
const prices = new Map<string, { input: number; output: number; cached: number }>();

async function refreshPrices() {
  const res = await fetch("${ctx.base}/models", { headers: { Authorization: \`Bearer \${process.env.API_KEY}\` } });
  for (const m of (await res.json()).data) {
    const y = m.x_pricing?.yours ?? {};
    prices.set(m.id, { input: y.input ?? 0, output: y.output ?? 0, cached: y.cached_input ?? y.input ?? 0 });
  }
}
await refreshPrices();
setInterval(refreshPrices, 10 * 60_000);

function costUsd(model: string, usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } }) {
  const p = prices.get(model)!;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return ((usage.prompt_tokens - cached) * p.input + cached * p.cached + usage.completion_tokens * p.output) / 1_000_000;
}`,
          },
          {
            id: "python",
            label: "Python",
            lang: "python",
            code: `import os, requests

def load_prices():
    r = requests.get("${ctx.base}/models", headers={"Authorization": f"Bearer {os.environ['API_KEY']}"}, timeout=30)
    return {m["id"]: m["x_pricing"]["yours"] for m in r.json()["data"] if "x_pricing" in m}

prices = load_prices()   # call again every few minutes

def cost_usd(model, usage):
    p = prices[model]
    cached = (usage.get("prompt_tokens_details") or {}).get("cached_tokens", 0)
    return ((usage["prompt_tokens"] - cached) * p["input"]
            + cached * p.get("cached_input", p["input"])
            + usage["completion_tokens"] * p["output"]) / 1_000_000`,
          },
        ]}
      />
      <P>
        The exact amount charged for every request (including tools, images and any surcharge) is shown in your <Link className={A} href="/dashboard/logs">Logs</Link> and in the usage export;
        the formula is explained under <Link className={A} href="/docs/billing">Billing</Link>.
      </P>
    </>
  );
}
