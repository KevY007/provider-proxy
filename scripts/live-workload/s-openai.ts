/** Scenarios L (reference image -> garment-flats techpack SVG with gpt-6-astra and Claude) and I (OpenAI models). */
import fs from "node:fs";
import { anthropic, openai, guard, raw, Scn, processSvg, textOf, ctx } from "./lib";
import { makeSamplePdf } from "./pdfutil";

// ------------------------------------------------------------------ L
export const L_INSTRUCTIONS = `You are a senior apparel technical designer. The attached photo is the REFERENCE garment (a men's twill chore jacket). Study it carefully (silhouette, collar, pockets, closure, seams, hem, cuffs) and produce a production techpack page for it as ONE single self-contained SVG document.

Output rules:
- Output ONLY the SVG markup, starting with <svg and ending with </svg>. No markdown fences and no text before or after it.
- viewBox="0 0 2400 1600" width="2400" height="1600", white background, font-family Arial/Helvetica only. No external resources, no <image>, no <foreignObject>, no scripts. Must be well-formed XML (escape & as &amp;).
- Draw everything with vector shapes: line art garment FLATS (outline stroke #111, 3px; seam/stitch lines dashed 1.5px), no photo, no gradients needed.

Page content (lay it out in a clean grid, nothing overlapping, text no smaller than 14px):
1. TITLE BLOCK across the top: STYLE NO. CJ-2027-014, STYLE NAME "Dockside Chore Jacket", SEASON Spring/Summer 2027, FABRIC "Cotton twill 8.5oz, garment washed", COLORWAY "Tobacco (Pantone 18-1031 TCX)", BASE SIZE M, DESIGNER, DATE, REV 01.
2. GARMENT FLATS: FRONT view, BACK view, SIDE view, plus DETAIL views: (D1) corduroy collar and stand, (D2) patch pocket with flap, (D3) cuff with button, (D4) hem and side-seam vent. All flats must resemble the reference garment: four patch pockets, corduroy collar, button front.
3. CALLOUTS: at least 14 numbered callouts with leader lines pointing at the exact garment feature. A callout list/table (No., detail, stitch type with SPI, e.g. "301 lockstitch 10 SPI topstitch 6mm", "401 chainstitch felled seam", bartack, bar-tack count, interfacing) linked to the numbers.
4. POINTS OF MEASURE: draw dimension lines on the FRONT and BACK flats with POM LETTERS (A, B, C, ... at least 10) and a small MEASUREMENT TABLE keyed by those letters: POM letter, description, sizes S M L XL in cm, tolerance (+/-). Include chest width, body length HPS, shoulder width, sleeve length, bicep, cuff opening, collar height, pocket size, hem sweep, back neck drop.
5. TRIMS table: 5 buttons (colour/size 20L tobacco corozo), main label, care label, size label, hang tag with placement and quantity.
6. COLORWAY block: swatch for the main fabric, corduroy collar, buttons, thread with Pantone codes.
7. CONSTRUCTION NOTES: numbered list of at least 8 notes (seam allowances, pocket attachment, collar construction, button placement spacing, finishing, wash).
Make it look like a professional, print-ready techpack page.`;


const L_WORDS = ["CJ-2027-014", "Dockside", "POINTS? OF MEASURE|POM", "TRIMS?", "COLORWAY", "CONSTRUCTION", "FRONT", "BACK", "SIDE", "stitch|SPI"];

async function makeReference(s: Scn): Promise<{ b64: string; mime: string } | null> {
  const r = await raw("/v1/images/generations", {
    anthropicStyle: false,
    body: { model: "flux-schnell", prompt: "flat-lay product photo of a men's twill chore jacket in tobacco brown, four patch pockets with flaps, corduroy collar, button front, plain white background, studio lighting", size: "1024x1024", n: 1, response_format: "b64_json" },
    timeoutMs: 240_000,
  });
  const j = (await r.res.json()) as { data?: Array<{ b64_json?: string }> };
  s.check("reference image via gateway (fal flux-schnell, b64_json)", r.res.status === 200 && !!j.data?.[0]?.b64_json, `HTTP ${r.res.status} ${r.ms} ms`);
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) return null;
  const buf = Buffer.from(b64, "base64");
  const mime = buf.subarray(0, 4).toString("hex") === "89504e47" ? "image/png" : buf.subarray(0, 3).toString("hex") === "ffd8ff" ? "image/jpeg" : "image/webp";
  s.save(`reference.${mime.split("/")[1].replace("jpeg", "jpg")}`, buf);
  return { b64, mime };
}

export async function scenarioL(s: Scn) {
  await guard("openai", 3);
  const ref = await makeReference(s);
  if (!ref) return;
  const url = `data:${ref.mime};base64,${ref.b64}`;

  const want = (process.env.WL_L_STEPS ?? "chat,responses,sonnet").split(",");
  // 1) gpt-6-astra, Chat Completions, streamed, via the official openai SDK
  if (want.includes("chat")) await s.step("gpt-6-astra via Chat Completions (stream, image_url, reasoning medium)", async () => {
    const c = openai();
    const t0 = Date.now();
    let ttft = 0;
    const stream = await c.chat.completions.create({
      model: "gpt-6-astra",
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 48000,
      reasoning_effort: "medium",
      messages: [{ role: "user", content: [{ type: "text", text: L_INSTRUCTIONS }, { type: "image_url", image_url: { url } }] }],
    });
    let text = "";
    let finish = "";
    let usage: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | undefined;
    let model = "";
    for await (const ch of stream) {
      model = ch.model;
      const d = ch.choices?.[0]?.delta?.content;
      if (d) {
        if (!ttft) ttft = Date.now() - t0;
        text += d;
      }
      if (ch.choices?.[0]?.finish_reason) finish = ch.choices[0].finish_reason;
      if (ch.usage) usage = ch.usage as never;
    }
    s.note(`astra chat: ${(Date.now() - t0) / 1000}s, first content ${ttft} ms, finish=${finish}, usage=${JSON.stringify(usage)}`);
    s.check("astra chat: finish_reason stop", finish === "stop", finish);
    s.check("astra chat: model masked to public slug", model === "gpt-6-astra", model);
    s.check("astra chat: usage chunk with reasoning tokens", !!usage?.prompt_tokens && !!usage?.completion_tokens, JSON.stringify(usage));
    await processSvg(s, "astra-chat", text, L_WORDS);
  });

  // 2) gpt-6-astra, Responses API, streamed, input_image
  if (want.includes("responses")) await s.step("gpt-6-astra via Responses API (stream, input_image, reasoning medium)", async () => {
    const c = openai();
    const t0 = Date.now();
    let ttft = 0;
    const stream = await c.responses.create({
      model: "gpt-6-astra",
      stream: true,
      max_output_tokens: 48000,
      reasoning: { effort: "medium" },
      input: [{ role: "user", content: [{ type: "input_text", text: L_INSTRUCTIONS }, { type: "input_image", image_url: url, detail: "high" }] }],
    });
    let text = "";
    let done: { status?: string; model?: string; usage?: Record<string, unknown> } | undefined;
    for await (const ev of stream) {
      if (ev.type === "response.output_text.delta") {
        if (!ttft) ttft = Date.now() - t0;
        text += ev.delta;
      } else if (ev.type === "response.completed" || ev.type === "response.incomplete" || ev.type === "response.failed") {
        done = ev.response as never;
      }
    }
    s.note(`astra responses: ${(Date.now() - t0) / 1000}s, first text ${ttft} ms, status=${done?.status}, usage=${JSON.stringify(done?.usage)}`);
    s.check("astra responses: completed", done?.status === "completed", `${done?.status}`);
    s.check("astra responses: model masked to public slug", done?.model === "gpt-6-astra", `${done?.model}`);
    await processSvg(s, "astra-responses", text, L_WORDS);
  });

  // 3) Claude Sonnet 5.5 via /v1/messages with the same image + prompt
  await guard("anthropic", 2);
  if (want.includes("sonnet")) await s.step("claude-sonnet-5-5 via /v1/messages (stream, base64 image) for comparison", async () => {
    const c = anthropic();
    const t0 = Date.now();
    const stream = c.messages.stream({
      model: "claude-sonnet-5-5",
      max_tokens: 48000,
      // Sonnet 5.5 thinks by default and a 48k budget was entirely eaten by thinking in the first attempt: keep thinking to between tool calls
      thinking: { type: "between_tools" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: ref.mime as "image/png", data: ref.b64 } }, { type: "text", text: L_INSTRUCTIONS }] }],
    });
    const msg = await stream.finalMessage();
    s.note(`sonnet: ${(Date.now() - t0) / 1000}s stop=${msg.stop_reason} usage=${JSON.stringify(msg.usage)}`);
    s.check("sonnet: end_turn", msg.stop_reason === "end_turn", `${msg.stop_reason}`);
    await processSvg(s, "sonnet-messages", textOf(msg.content as never), L_WORDS);
  });
}

// ------------------------------------------------------------------ I
const FABRIC_TOOL = { type: "function" as const, name: "get_fabric_price", description: "Get the price per metre in USD of a fabric.", strict: false, parameters: { type: "object", properties: { fabric: { type: "string" } }, required: ["fabric"], additionalProperties: false } };

export async function scenarioI(s: Scn) {
  await guard("openai", 1);
  const c = openai();

  await s.step("Responses API + function tool + streaming (gpt-5-mini), 2 tool rounds via previous_response_id", async () => {
    const price: Record<string, number> = { "cotton fleece 380gsm": 6.4, "rib 2x2": 5.1, "denim 12oz": 4.2 };
    let input: unknown = "I need fabric prices: look up 'cotton fleece 380gsm' and 'rib 2x2' with the tool, then tell me the total for 1.9 m of fleece and 0.25 m of rib.";
    let prev: string | undefined;
    let rounds = 0;
    let final = "";
    for (let i = 0; i < 6; i++) {
      const stream = await c.responses.create({ model: "gpt-5-mini", stream: true, max_output_tokens: 4000, reasoning: { effort: "low" }, tools: [FABRIC_TOOL], input: input as never, previous_response_id: prev });
      const calls: Array<{ call_id: string; name: string; arguments: string }> = [];
      let text = "";
      let id = "";
      for await (const ev of stream) {
        if (ev.type === "response.output_item.done" && ev.item.type === "function_call") calls.push({ call_id: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments });
        else if (ev.type === "response.output_text.delta") text += ev.delta;
        else if (ev.type === "response.completed") id = ev.response.id;
      }
      s.check(`responses round ${i + 1}: got response id`, !!id, id);
      if (!calls.length) {
        final = text;
        break;
      }
      rounds++;
      prev = id;
      input = calls.map((cl) => ({ type: "function_call_output", call_id: cl.call_id, output: JSON.stringify({ price_per_m: price[JSON.parse(cl.arguments).fabric] ?? 3 }) }));
    }
    s.check("responses: at least 1 tool round trip then a final answer", rounds >= 1 && final.length > 0, `${rounds} rounds; answer: ${final.slice(0, 120).replace(/\s+/g, " ")}`);
    s.check("responses: answer contains the right total (1.9*6.4+0.25*5.1=13.435)", /13\.4/.test(final), final.slice(0, 160));
  });

  await s.step("Chat stream with the official SDK (gpt-4o-mini) + usage", async () => {
    const stream = await c.chat.completions.create({ model: "gpt-4o-mini", stream: true, stream_options: { include_usage: true }, max_tokens: 200, messages: [{ role: "user", content: "List 5 garment seam types in one line." }] });
    let text = "";
    let usage: { completion_tokens?: number } | undefined;
    for await (const ch of stream) {
      text += ch.choices?.[0]?.delta?.content ?? "";
      if (ch.usage) usage = ch.usage;
    }
    s.check("chat stream text + usage", text.length > 10 && !!usage?.completion_tokens, `${text.slice(0, 60)}`);
  });

  await s.step("20 short SDK chat streams (gpt-4o-mini): every one must be logged SUCCESS (SDK closes the socket right after [DONE])", async () => {
    for (let i = 0; i < 20; i++) {
      const stream = await c.chat.completions.create({ model: "gpt-4o-mini", stream: true, stream_options: { include_usage: true }, max_tokens: 12, messages: [{ role: "user", content: `Say the word ${i}.` }] });
      for await (const ch of stream) void ch;
    }
  });

  await s.step("Image generation (gpt-image-1-mini, quality low, 1024x1024)", async () => {
    const r = await c.images.generate({ model: "gpt-image-1-mini", prompt: "A flat technical sketch of a hoodie, front view, black line art on white", size: "1024x1024", quality: "low", n: 1 });
    const b64 = r.data?.[0]?.b64_json;
    s.check("image returned as b64_json", !!b64);
    if (b64) s.save("image.png", Buffer.from(b64, "base64"));
  });

  await s.step("Embeddings (text-embedding-3-small)", async () => {
    const r = await c.embeddings.create({ model: "text-embedding-3-small", input: ["cotton fleece hoodie", "polyester windbreaker", "denim jacket"] });
    s.check("3 embeddings x 1536 dims, model masked", r.data.length === 3 && r.data[0].embedding.length === 1536 && r.model === "text-embedding-3-small", r.model);
  });

  await s.step("Files upload + Responses input_file (gpt-5-mini) + delete", async () => {
    const pdf = await makeSamplePdf();
    const f = await c.files.create({ file: new File([new Uint8Array(pdf)], "techpack.pdf", { type: "application/pdf" }), purpose: "user_data" });
    s.check("file uploaded through the gateway", !!f.id, f.id);
    const r = await c.responses.create({ model: "gpt-5-mini", max_output_tokens: 2000, reasoning: { effort: "low" }, input: [{ role: "user", content: [{ type: "input_file", file_id: f.id }, { type: "input_text", text: "What is the factory code and the base size? Answer briefly." }] }] });
    s.check("answer uses the file content (ZEBRA-7731)", /ZEBRA-7731/.test(r.output_text), r.output_text.slice(0, 100));
    const del = await c.files.delete(f.id);
    s.check("file deleted", del.deleted === true);
    void fs;
    void ctx;
  });
}
