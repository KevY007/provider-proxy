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
        Set <C>stream: true</C> and the response arrives as server-sent events (<C>text/event-stream</C>) in the same shape as the upstream API for the endpoint you called. Bytes are
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
        Usage is read from the final event of the stream. If the client disconnects early, the request is cancelled upstream and billed for the tokens received so far (estimated when the
        provider has not reported usage yet). Errors before the first byte are returned as normal JSON errors with the proper HTTP status; once streaming has started, failures are sent
        as an error event.
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
      <P>Image models are billed per generated image (shown on the Pricing page) or, for token-billed models, by the tokens the model reports, times your pool multiplier. Each request shows its exact cost in your Logs.</P>
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
        <li>The job is charged <strong>when it is created</strong>: requested seconds times the per-second price of the model, times your pool multiplier.</li>
        <li>If a job later ends as <C>failed</C>, the full charge is refunded to your balance automatically (shown as a Refund in your ledger), exactly once.</li>
        <li>Polling and downloading are free. Videos are only visible to the account that created them; any other key gets <C>404</C>.</li>
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
        When upstream capacity is temporarily saturated we hold your request in a short queue (up to about 20 seconds) instead of failing it. If capacity is still not available you get{" "}
        <C>429 no_capacity</C> with a <C>retry-after</C> hint. Upstream 429s and 5xx errors are retried transparently on other capacity before they ever reach you.
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

export function billing() {
  return (
    <>
      <P>{`Billing is prepaid pay-as-you-go: add balance, and each request deducts its exact cost. There is no subscription or minimum spend.`}</P>
      <H2>How a request is priced</H2>
      <CodeBlock
        lang="text"
        code={`price = ( uncached_input x input_price
        + cached_input   x cached_price
        + output (incl. reasoning) x output_price ) / 1,000,000
        x pool multiplier x your price multiplier
        + per-image / per-request charges`}
      />
      <UL>
        <li><strong>Pools</strong> have a price multiplier (for example Pro = 0.8x). Choose a pool per key when creating it.</li>
        <li><strong>Cached tokens</strong> are cheaper than normal input on models that support prompt caching.</li>
        <li><strong>Long-context</strong> requests above a model&apos;s threshold may carry a surcharge, noted on the Pricing page.</li>
        <li>Failed requests (4xx/5xx) that produced no usage are not charged.</li>
      </UL>
      <H2>Adding balance</H2>
      <UL>
        <li>Top up any amount by card from the <Link className={A} href="/dashboard/billing">Billing</Link> page.</li>
        <li>Enable <strong>auto-recharge</strong> to top up automatically when your balance drops below a threshold.</li>
        <li>Redeem codes are credited instantly.</li>
        <li>When the balance is exhausted, requests fail with <C>402 insufficient_balance</C> until you add funds.</li>
      </UL>
      <H2>Spend controls</H2>
      <P>Set a lifetime <strong>spend limit per key</strong> and a monthly spend limit for your account to cap exposure. Reaching a limit returns <C>402 spend_limit_reached</C>.</P>
      <P>See your spend by model, key and endpoint on the Usage page, and every request in Logs.</P>
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
        code={`{ "error": { "message": "Insufficient balance", "type": "insufficient_balance", "code": "insufficient_balance", "param": null } }`}
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
        Retry <C>429</C>, <C>502</C>, <C>503</C> and <C>504</C> with exponential backoff and honour <C>retry-after</C>. Do not retry <C>400</C>, <C>401</C>, <C>402</C>, <C>403</C> or <C>404</C> without changing something first.
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
