/** Scenarios D (agentic features) and E (long context). */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, guard, raw, Scn, textOf, renderSvg, ctx, db } from "./lib";
import { makeSamplePdf } from "./pdfutil";

const FABRICS: Record<string, number> = { "cotton fleece 380gsm": 6.4, "rib 2x2": 5.1, "flat cotton drawcord": 0.35, "metal eyelet": 0.08, "woven main label": 0.12 };
const TOOL = {
  name: "get_fabric_price",
  description: "Look up the supplier price per unit (metre or piece) in USD of a fabric or trim by name.",
  input_schema: { type: "object" as const, properties: { item: { type: "string", description: "e.g. 'cotton fleece 380gsm'" } }, required: ["item"] },
};

async function nextId(res: { response: Response }) {
  return res.response.headers.get("x-request-id");
}

// ------------------------------------------------------------------ D
export async function scenarioD(s: Scn) {
  await guard("anthropic", 4);
  const c = anthropic();

  // ---- D1 extended thinking + client tool loop
  await s.step("D1 extended thinking (streamed) + tool loop with 3+ round trips, signatures preserved", async () => {
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: "Cost a hoodie BOM. Look up these items with the tool ONE AT A TIME, in this order: 'cotton fleece 380gsm', 'rib 2x2', 'flat cotton drawcord', 'metal eyelet'. Quantities: 1.9, 0.25, 1.5, 2. Then give the total material cost per piece. Plan the work first and double-check the total with a second method." }];
    let rounds = 0;
    let sawThinkingDelta = false;
    let sawSignatureDelta = false;
    let thinkingBlocks = 0;
    let signed = 0;
    let final: Anthropic.Message | undefined;
    for (let i = 0; i < 8; i++) {
      const stream = c.messages.stream({
        model: "claude-sonnet-5-5",
        max_tokens: 16000,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
        tools: [TOOL],
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        messages,
      } as never);
      stream.on("streamEvent", (ev) => {
        if (ev.type === "content_block_delta") {
          if (ev.delta.type === "thinking_delta") sawThinkingDelta = true;
          if (ev.delta.type === "signature_delta") sawSignatureDelta = true;
        }
      });
      const msg = await stream.finalMessage();
      for (const b of msg.content) if (b.type === "thinking") {
        thinkingBlocks++;
        if ((b as { signature?: string }).signature) signed++;
      }
      messages.push({ role: "assistant", content: msg.content as never });
      if (msg.stop_reason !== "tool_use") {
        final = msg;
        break;
      }
      rounds++;
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const b of msg.content) if (b.type === "tool_use") results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify({ price_usd: FABRICS[(b.input as { item: string }).item] ?? null }) });
      messages.push({ role: "user", content: results });
    }
    s.save("d1-thinking-toolloop.json", messages);
    s.check("tool loop ran 3+ round trips without a 400 (thinking signatures accepted on replay)", rounds >= 3 && !!final, `${rounds} tool rounds`);
    s.check("thinking blocks streamed (thinking_delta + signature_delta events passed through)", thinkingBlocks > 0 && sawSignatureDelta, `blocks=${thinkingBlocks} signed=${signed} thinking_delta=${sawThinkingDelta} signature_delta=${sawSignatureDelta}`);
    s.check("every thinking block carries a signature", thinkingBlocks > 0 && signed === thinkingBlocks, `${signed}/${thinkingBlocks}`);
    const t = final ? textOf(final.content as never) : "";
    const total = 1.9 * 6.4 + 0.25 * 5.1 + 1.5 * 0.35 + 2 * 0.08;
    s.check(`final answer has the right total (${total.toFixed(3)})`, new RegExp(total.toFixed(2).replace(".", "\\.")).test(t) || /14\.1/.test(t), t.slice(0, 160).replace(/\s+/g, " "));
  });

  // ---- D2 web search
  await s.step("D2 server tool web_search_20260209", async () => {
    const msg = await c.messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: 8000,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 2 } as never],
      messages: [{ role: "user", content: "Search the web: what was Pantone's Color of the Year for 2026? Answer in one sentence with the colour name and code." }],
    });
    s.save("d2-websearch.json", msg);
    const blocks = msg.content as unknown as Array<{ type: string; content?: unknown }>;
    const wsr = blocks.find((b) => b.type === "web_search_tool_result");
    const uses = (msg.usage as { server_tool_use?: { web_search_requests?: number } }).server_tool_use?.web_search_requests ?? 0;
    s.check("web_search_tool_result present with results (list)", !!wsr && Array.isArray(wsr.content), wsr ? (Array.isArray(wsr.content) ? `${(wsr.content as unknown[]).length} results` : JSON.stringify(wsr.content).slice(0, 200)) : msg.content.map((b) => b.type).join(","));
    s.check("usage.server_tool_use.web_search_requests > 0 reported", uses > 0, `${uses}`);
    s.note(`web search answer: ${textOf(msg.content as never).slice(0, 200).replace(/\s+/g, " ")}`);
    if (uses > 0) s.note(`web_search_requests=${uses}: Anthropic bills $10/1000 searches; RequestLog has no field for server-tool usage (see report: server tool fees are not metered)`);
  });

  // ---- D3 code execution (simple)
  await s.step("D3 server tool code_execution_20260521 (compute + stdout)", async () => {
    const tools = [{ type: "code_execution_20260521", name: "code_execution" }] as never;
    let msg: Anthropic.Message;
    try {
      msg = await c.messages.create({ model: "claude-sonnet-5-5", max_tokens: 8000, tools, messages: [{ role: "user", content: "Use code execution to compute the sum of squares of 1..100 and print it. Reply with just the number." }] });
    } catch (e) {
      s.note(`without beta header failed (${(e as Error).message.slice(0, 160)}); retrying with code-execution-2025-08-25`);
      msg = (await c.beta.messages.create({ model: "claude-sonnet-5-5", max_tokens: 8000, tools, betas: ["code-execution-2025-08-25"], messages: [{ role: "user", content: "Use code execution to compute the sum of squares of 1..100 and print it. Reply with just the number." }] } as never)) as never;
    }
    s.save("d3-codeexec.json", msg);
    s.check("answer 338350", /338,?350/.test(textOf(msg.content as never)), textOf(msg.content as never).slice(0, 80));
    s.check("code execution result block with stdout", JSON.stringify(msg.content).includes("338350"), msg.content.map((b) => b.type).join(","));
  });

  // ---- D4 prompt caching
  await s.step("D4 prompt caching: 2nd call reads the cache and is billed at the cached price", async () => {
    const lines: string[] = [];
    for (let i = 1; i <= 420; i++) lines.push(`Fabric library entry ${i}: composition ${i % 3 ? "100% cotton" : "60/40 cotton polyester"}, weight ${180 + (i % 40) * 10}gsm, supplier code SUP-${1000 + i * 7}, shrinkage ${(i % 5) + 1}.${i % 10}%, MOQ ${100 * (1 + (i % 6))} m, lead time ${14 + (i % 30)} days.`);
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: "You are a fabric sourcing assistant. Use this library:\n" + lines.join("\n"), cache_control: { type: "ephemeral" } }];
    const ask = async (q: string) => {
      const r = await c.messages.create({ model: "claude-sonnet-5-5", max_tokens: 300, system, messages: [{ role: "user", content: q }] }).withResponse();
      return { msg: r.data, rid: await nextId(r) };
    };
    const a = await ask("What is the supplier code of entry 100? One line.");
    await new Promise((r) => setTimeout(r, 2500));
    const b = await ask("What is the MOQ of entry 7? One line.");
    const ua = a.msg.usage, ub = b.msg.usage;
    s.note(`call1 usage ${JSON.stringify({ i: ua.input_tokens, cw: ua.cache_creation_input_tokens, cr: ua.cache_read_input_tokens, o: ua.output_tokens })}; call2 usage ${JSON.stringify({ i: ub.input_tokens, cw: ub.cache_creation_input_tokens, cr: ub.cache_read_input_tokens, o: ub.output_tokens })}`);
    s.check("call 1 wrote the cache", (ua.cache_creation_input_tokens ?? 0) > 1000 || (ua.cache_read_input_tokens ?? 0) > 1000, `${ua.cache_creation_input_tokens}`);
    s.check("call 2 shows cache_read_input_tokens > 0", (ub.cache_read_input_tokens ?? 0) > 1000, `${ub.cache_read_input_tokens}`);
    for (const [tag, x] of [["call1", a], ["call2", b]] as const) {
      const log = x.rid ? await waitLogLocal(x.rid) : null;
      if (!log) {
        s.check(`${tag}: RequestLog row`, false);
        continue;
      }
      s.check(`${tag}: RequestLog cachedTokens == usage.cache_read_input_tokens`, log.cachedTokens === (x.msg.usage.cache_read_input_tokens ?? 0), `${log.cachedTokens} vs ${x.msg.usage.cache_read_input_tokens}`);
      s.check(`${tag}: RequestLog cacheWriteTokens == usage.cache_creation_input_tokens`, log.cacheWriteTokens === (x.msg.usage.cache_creation_input_tokens ?? 0), `${log.cacheWriteTokens} vs ${x.msg.usage.cache_creation_input_tokens}`);
      s.check(`${tag}: RequestLog inputTokens == input + cache read + cache write`, log.inputTokens === x.msg.usage.input_tokens + (x.msg.usage.cache_read_input_tokens ?? 0) + (x.msg.usage.cache_creation_input_tokens ?? 0), `${log.inputTokens} vs ${x.msg.usage.input_tokens}+${x.msg.usage.cache_read_input_tokens}+${x.msg.usage.cache_creation_input_tokens}`);
    }
    const l1 = a.rid ? await waitLogLocal(a.rid) : null;
    const l2 = b.rid ? await waitLogLocal(b.rid) : null;
    if (l1 && l2) s.check("call 2 costs (and is priced) less than call 1", Number(l2.price) < Number(l1.price) && Number(l2.cost) < Number(l1.cost), `price ${l1.price} -> ${l2.price}; cost ${l1.cost} -> ${l2.cost}`);
  });

  // ---- D5 files + PDF doc input, image input, count_tokens
  const h = new Anthropic({ apiKey: ctx.key, baseURL: process.env.WL_BASE_URL ?? "http://localhost:3011", maxRetries: 0 });
  void h;
  let fileId = "";
  await s.step("D5a upload a PDF through /v1/files and reference it by file_id in /v1/messages", async () => {
    const pdf = await makeSamplePdf();
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(pdf)], { type: "application/pdf" }), "techpack.pdf");
    const up = await raw("/v1/files", { form, headers: { "anthropic-beta": "files-api-2025-04-14" } });
    const uj = (await up.res.json()) as { id?: string };
    s.check("POST /v1/files (multipart) -> file id", up.res.status === 200 && !!uj.id, `HTTP ${up.res.status} ${JSON.stringify(uj).slice(0, 160)}`);
    fileId = uj.id ?? "";
    if (!fileId) return;
    const m = await raw("/v1/messages", {
      headers: { "anthropic-beta": "files-api-2025-04-14" },
      body: { model: "claude-haiku-5-5", max_tokens: 400, messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: fileId }, title: "techpack" }, { type: "text", text: "What is the factory code and what is dimension E (cuff opening) in cm? Answer briefly." }] }] },
    });
    const mj = (await m.res.json()) as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens: number } };
    const t = textOf(mj.content ?? []);
    s.check("model read the PDF (ZEBRA-7731, 9 cm)", m.res.status === 200 && /ZEBRA-7731/.test(t) && /\b9\b/.test(t), `HTTP ${m.res.status}: ${t.slice(0, 120).replace(/\s+/g, " ")}`);
    const meta = await raw(`/v1/files/${fileId}`, { headers: { "anthropic-beta": "files-api-2025-04-14" } });
    s.check("GET /v1/files/{id} metadata", meta.res.status === 200, `HTTP ${meta.res.status}`);
    const dl = await raw(`/v1/files/${fileId}/content`, { headers: { "anthropic-beta": "files-api-2025-04-14" } });
    s.check("uploaded user file download (Anthropic only allows downloading generated files: 4xx is expected)", [200, 400, 403, 404].includes(dl.res.status), `HTTP ${dl.res.status}`);
    await dl.res.arrayBuffer();
    const del = await raw(`/v1/files/${fileId}`, { method: "DELETE", headers: { "anthropic-beta": "files-api-2025-04-14" } });
    s.check("DELETE /v1/files/{id}", del.res.status === 200, `HTTP ${del.res.status}`);
  });

  await s.step("D5b image input (base64 PNG, haiku-5-5) + count_tokens", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="240"><rect width="600" height="240" fill="white"/><text x="30" y="150" font-size="96" font-family="Arial" font-weight="bold" fill="black">SKU 4821</text></svg>`;
    const f = s.save("d5b-input.svg", svg);
    const p = path.join(s.dir, "d5b-input.png");
    const r = await renderSvg(f, p, 600);
    s.check("generated test image", r.ok, r.error ?? "");
    const b64 = fs.readFileSync(p).toString("base64");
    const content = [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: b64 } }, { type: "text" as const, text: "What SKU number is written in the image? Reply with just the number." }];
    const ct = await c.messages.countTokens({ model: "claude-haiku-5-5", messages: [{ role: "user", content }] });
    s.check("POST /v1/messages/count_tokens works through the gateway", ct.input_tokens > 0, `${ct.input_tokens} tokens`);
    const m = await c.messages.create({ model: "claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user", content }] });
    s.check("model read 4821 from the image", /4821/.test(textOf(m.content as never)), textOf(m.content as never));
  });
}

async function waitLogLocal(rid: string) {
  for (let i = 0; i < 200; i++) {
    const row = await db.requestLog.findUnique({ where: { id: rid } });
    if (row) return row;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

// ------------------------------------------------------------------ E
export async function scenarioE(s: Scn) {
  await guard("anthropic", 3);
  const c = anthropic();
  const rec = (i: number) => `Record ${i}: style ST-${10000 + i * 13}, supplier SUP-${(i * 37) % 997}, fabric lot L${(i * 91) % 5003}, shell cotton twill ${180 + (i % 60) * 5}gsm, colour ${["indigo", "bone", "moss", "charcoal", "tobacco", "navy"][i % 6]}, unit cost ${(3 + (i % 17) * 0.37).toFixed(2)} USD, remark: cutting ticket ${i * 7 + 11} released to line ${(i % 12) + 1} on week ${(i % 52) + 1}.`;
  // calibrate tokens per record with count_tokens
  const sample = Array.from({ length: 200 }, (_, i) => rec(i + 1)).join("\n");
  const cal = await c.messages.countTokens({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: sample }] });
  const perRec = cal.input_tokens / 200;
  const n = Math.round(150_000 / perRec);
  s.note(`calibration: ${perRec.toFixed(1)} tokens/record -> ${n} records for ~150k tokens`);
  const needleAt = Math.round(n * 0.62);
  const rows: string[] = [];
  for (let i = 1; i <= n; i++) {
    rows.push(rec(i));
    if (i === needleAt) rows.push("NOTE FOR THE SAMPLE ROOM: the vault passphrase is INDIGO-OTTER-8842. Do not share it outside the techpack team.");
  }
  const doc = rows.join("\n");
  s.save("e-prompt-stats.json", { records: n, chars: doc.length, needleAt });
  const call = async () => {
    const t0 = Date.now();
    const r = await c
      .messages.create({ model: "claude-sonnet-5-5", max_tokens: 2000, messages: [{ role: "user", content: [{ type: "text", text: doc, cache_control: { type: "ephemeral" } }, { type: "text", text: "\n\nQuestion: what is the vault passphrase mentioned in the sample room note? Reply with only the passphrase." }] }] })
      .withResponse();
    return { msg: r.data, rid: await nextId(r), ms: Date.now() - t0 };
  };
  const a = await call();
  s.note(`call1: ${(a.ms / 1000).toFixed(1)}s usage ${JSON.stringify(a.msg.usage)} answer: ${textOf(a.msg.content as never).slice(0, 80)}`);
  s.check("call 1 (cold, ~150k tokens) finds the needle", /INDIGO-OTTER-8842/.test(textOf(a.msg.content as never)), textOf(a.msg.content as never).slice(0, 80));
  const total = a.msg.usage.input_tokens + (a.msg.usage.cache_creation_input_tokens ?? 0) + (a.msg.usage.cache_read_input_tokens ?? 0);
  s.check("prompt really was ~150k tokens", total > 135_000 && total < 175_000, `${total}`);
  await new Promise((r) => setTimeout(r, 3000));
  const b = await call();
  s.note(`call2: ${(b.ms / 1000).toFixed(1)}s usage ${JSON.stringify(b.msg.usage)}`);
  s.check("call 2 reads the big prefix from the cache", (b.msg.usage.cache_read_input_tokens ?? 0) > 100_000, `${b.msg.usage.cache_read_input_tokens}`);
  const l1 = a.rid ? await waitLogLocal(a.rid) : null;
  const l2 = b.rid ? await waitLogLocal(b.rid) : null;
  if (l1 && l2) {
    s.note(`call1 log: in=${l1.inputTokens} cw=${l1.cacheWriteTokens} price=${l1.price} cost=${l1.cost} official=${l1.officialPrice} latency=${l1.latencyMs}ms; call2 log: in=${l2.inputTokens} cached=${l2.cachedTokens} price=${l2.price} cost=${l2.cost} latency=${l2.latencyMs}ms`);
    s.check("cached call is much cheaper than the cold call", Number(l2.price) < Number(l1.price) * 0.5, `${l1.price} -> ${l2.price}`);
  }
}
