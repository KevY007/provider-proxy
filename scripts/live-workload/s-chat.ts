/** Scenarios A (chat like a real user), B (techpack SVG), K (message batches). */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, guard, raw, Scn, textOf, TECHPACK_PROMPT, extractSvg, xmlWellFormed, renderSvg, sleep } from "./lib";

type Msg = Anthropic.MessageParam;

function pub(s: Scn, model: string, m: { model: string }) {
  s.check(`${model}: response.model is the public slug`, m.model === model, m.model);
}

// ------------------------------------------------------------------ A
const TURNS = [
  "Hi! I'm launching a small streetwear label. I want to make a heavyweight hoodie from 380gsm cotton fleece in Harbor Navy. Give me a 3-bullet summary of what a techpack for it must contain.",
  "Good. Remember: the fabric is 380gsm cotton fleece and the colour is Harbor Navy. Which stitch type should I use for the side seams, and why? Keep it to 3 sentences.",
  "I'm worried about shrinkage. What wash/pre-shrink step do you recommend and what shrinkage tolerance should the techpack state? Short answer.",
  "My factory quotes 11.80 USD per piece at 500 units. If I sell at 89 USD retail and wholesale at 45 USD, what is my wholesale gross margin percentage per piece? Show the arithmetic.",
  "Now, without me repeating it: what fabric weight and colour did I tell you at the start? Answer in one line.",
  "Last one: write a two-line care label text for this garment.",
];

async function chatTurns(s: Scn, model: string, streamFrom: number) {
  const c = anthropic();
  const messages: Msg[] = [];
  let lastText = "";
  for (let i = 0; i < TURNS.length; i++) {
    messages.push({ role: "user", content: TURNS[i] });
    const t0 = Date.now();
    let msg: Anthropic.Message;
    if (i >= streamFrom) {
      const stream = c.messages.stream({ model, max_tokens: 6000, system: "You are a helpful apparel-industry production assistant. Be concise.", messages });
      let deltas = 0;
      stream.on("text", () => deltas++);
      msg = await stream.finalMessage();
      s.check(`${model} turn ${i + 1} (SDK messages.stream): got text deltas`, deltas > 0, `${deltas} deltas, ${Date.now() - t0} ms`);
    } else {
      msg = await c.messages.create({ model, max_tokens: 6000, system: "You are a helpful apparel-industry production assistant. Be concise.", messages });
    }
    lastText = textOf(msg.content as never);
    s.check(`${model} turn ${i + 1}: end_turn + text + usage`, msg.stop_reason === "end_turn" && lastText.length > 5 && msg.usage.input_tokens > 0 && msg.usage.output_tokens > 0, `stop=${msg.stop_reason} out=${msg.usage.output_tokens}`);
    pub(s, model, msg);
    messages.push({ role: "assistant", content: msg.content as never });
    if (i === 3) s.check(`${model}: margin arithmetic plausible (73.8% / 73.77)`, /73\.[78]/.test(lastText), lastText.slice(0, 80).replace(/\s+/g, " "));
    if (i === 4) s.check(`${model}: remembers 380gsm + Harbor Navy`, /380/.test(lastText) && /navy/i.test(lastText), lastText.slice(0, 100).replace(/\s+/g, " "));
  }
  s.save(`${model}-conversation.json`, messages);
}

export async function scenarioA(s: Scn) {
  await guard("anthropic", 3);
  await s.step("claude-sonnet-5-5: 6-turn conversation (4 plain, 2 streamed)", () => chatTurns(s, "claude-sonnet-5-5", 4));
  await s.step("claude-haiku-5-5: 6-turn conversation (3 plain, 3 streamed)", () => chatTurns(s, "claude-haiku-5-5", 3));
  const c = anthropic();
  for (const model of ["claude-opus-5-5", "claude-fable-5-1"]) {
    await s.step(`${model}: one turn`, async () => {
      const m = await c.messages.create({ model, max_tokens: 4000, messages: [{ role: "user", content: "In two sentences: what is a 'tolerance' column in a garment measurement chart?" }] });
      const t = textOf(m.content as never);
      s.save(`${model}-turn.json`, m);
      s.check(`${model}: text answer`, t.length > 20 && m.stop_reason === "end_turn", `stop=${m.stop_reason} in=${m.usage.input_tokens} out=${m.usage.output_tokens}`);
      pub(s, model, m);
    });
  }
  await s.step("GET /v1/models (Anthropic shape) lists the models used", async () => {
    const list = await c.models.list();
    const ids = list.data.map((m) => m.id);
    for (const id of ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-fable-5-1"]) s.check(`models list contains ${id}`, ids.includes(id));
  });
}

// ------------------------------------------------------------------ B
async function svgFor(s: Scn, model: string, via: "anthropic") {
  void via;
  await guard("anthropic", 2);
  const c = anthropic();
  const t0 = Date.now();
  let ttft = 0;
  // Sonnet 5.5 thinks by default (a 48k budget was fully consumed by thinking in a first attempt): sonnet -> thinking only between tools,
  // opus 5.5 cannot disable thinking -> effort low
  const tuning = model.includes("sonnet") ? { thinking: { type: "between_tools" } } : { output_config: { effort: "low" } };
  const stream = c.messages.stream({ model, max_tokens: 48000, ...tuning, messages: [{ role: "user", content: TECHPACK_PROMPT }] } as never);
  stream.on("text", () => {
    if (!ttft) ttft = Date.now() - t0;
  });
  const msg = await stream.finalMessage();
  const ms = Date.now() - t0;
  const text = textOf(msg.content as never);
  s.check(`${model}: stream finished with end_turn`, msg.stop_reason === "end_turn", `stop=${msg.stop_reason} out=${msg.usage.output_tokens} tok in ${(ms / 1000).toFixed(0)}s, first text after ${ttft} ms`);
  pub(s, model, msg);
  const svg = extractSvg(text);
  s.check(`${model}: output contains an <svg> document`, !!svg, `${text.length} chars`);
  if (!svg) {
    s.save(`${model}-raw.txt`, text);
    return;
  }
  const file = s.save(`techpack-${model}.svg`, svg);
  const wf = xmlWellFormed(file);
  s.check(`${model}: SVG is well-formed XML`, wf.ok, wf.error ?? `${(svg.length / 1024).toFixed(0)} KiB`);
  const png = path.join(s.dir, `techpack-${model}.png`);
  const r = await renderSvg(file, png);
  if (r.ok) s.artifacts.push(path.relative(process.cwd(), png).replace(/\\/g, "/"));
  s.check(`${model}: SVG renders to PNG (resvg)`, r.ok, r.ok ? `${r.w}x${r.h}, ${(fs.statSync(png).size / 1024).toFixed(0)} KiB` : r.error);
  const hits = ["POINTS OF MEASURE", "BILL OF MATERIALS", "CONSTRUCTION", "COLORWAY", "FRONT", "BACK"].filter((k) => new RegExp(k, "i").test(svg));
  s.check(`${model}: has all requested sections`, hits.length === 6, `found ${hits.join(", ")}`);
}
export async function scenarioB(s: Scn) {
  await s.step("claude-sonnet-5-5 techpack SVG (streamed, max_tokens 48k)", () => svgFor(s, "claude-sonnet-5-5", "anthropic"));
  await s.step("claude-opus-5-5 techpack SVG (streamed, max_tokens 48k)", () => svgFor(s, "claude-opus-5-5", "anthropic"));
}

// ------------------------------------------------------------------ K
export async function scenarioK(s: Scn) {
  const requests = [1, 2, 3].map((i) => ({ custom_id: `req-${i}`, params: { model: "claude-haiku-5-5", max_tokens: 200, messages: [{ role: "user", content: `Reply with exactly: batch-${i}-ok` }] } }));
  const create = await raw("/v1/messages/batches", { body: { requests } });
  const body = await create.res.text();
  s.save("create-response.txt", `HTTP ${create.res.status}\nrequest-id: ${create.rid}\n${body}`);
  s.note(`POST /v1/messages/batches -> HTTP ${create.res.status}: ${body.slice(0, 300)}`);
  let id = "";
  try {
    id = JSON.parse(body).id ?? "";
  } catch {
    /* not json */
  }
  if (create.res.status !== 200 || !id) {
    s.check("POST /v1/messages/batches is supported by the gateway", false, `HTTP ${create.res.status} ${body.slice(0, 200)}`);
    s.bug(`Anthropic Message Batches are not supported: POST /v1/messages/batches with 3 haiku-5-5 requests -> HTTP ${create.res.status} ${body.slice(0, 200)} (request id ${create.rid})`);
    return;
  }
  s.check("batch created", true, id);
  let status = "";
  for (let i = 0; i < 120; i++) {
    const g = await raw(`/v1/messages/batches/${id}`);
    const j = (await g.res.json()) as { processing_status?: string };
    status = j.processing_status ?? "";
    if (status === "ended") break;
    await sleep(5000);
  }
  s.check("batch reaches processing_status=ended", status === "ended", status);
  const r = await raw(`/v1/messages/batches/${id}/results`);
  const txt = await r.res.text();
  s.save("results.jsonl", txt);
  const lines = txt.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  s.check("results contain 3 succeeded entries", lines.length === 3 && lines.every((l) => l.result?.type === "succeeded"), `${lines.length} lines`);
}
