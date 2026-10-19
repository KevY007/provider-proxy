/** Scenario C: techpack as PDF. (1) Anthropic code execution tool -> Files API download via the gateway. (2) HTML -> PDF locally (comparison). */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic, guard, raw, Scn, textOf, extractSvg, ROOT } from "./lib";
import { pdfPageCount } from "./pdfutil";

const PDF_PROMPT = `Build a professional multi-page (at least 4 pages, A4) apparel TECHPACK PDF for a unisex heavyweight pullover hoodie (style TP-2026-HD01 "Harbor Hoodie", Fall/Winter 2026) using Python in the code sandbox.
Use reportlab if it is installed (otherwise matplotlib's PdfPages or any available PDF library; try pip install reportlab first).
Pages: (1) cover/title block with style info and a front+back flat sketch drawn with vector shapes, (2) points-of-measure table with 12+ measurements for sizes XS-XL and tolerances, (3) bill of materials table with 10+ lines, (4) construction notes (10+ numbered notes) and a colorway page with 4 colour swatches and Pantone codes.
Save it as techpack.pdf in the current working directory, then verify the page count with pypdf and tell me the page count and the file name.`;

type Block = { type: string; [k: string]: unknown };

async function runCodeExec(s: Scn, useBeta: boolean) {
  const c = anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: PDF_PROMPT }];
  const tools = [{ type: "code_execution_20260521", name: "code_execution" }] as never;
  const all: Block[] = [];
  let last: Anthropic.Beta.BetaMessage | undefined;
  for (let turn = 0; turn < 6; turn++) {
    const params = { model: "claude-sonnet-5-5", max_tokens: 32000, tools, messages, ...(useBeta ? { betas: ["code-execution-2025-08-25"] } : {}) } as never;
    const stream = c.beta.messages.stream(params);
    last = await stream.finalMessage();
    all.push(...(last.content as unknown as Block[]));
    s.note(`turn ${turn + 1}: stop=${last.stop_reason} blocks=${last.content.map((b) => b.type).join(",")}`);
    if (last.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: last.content as never });
  }
  return { last, all };
}

export async function scenarioC(s: Scn) {
  await guard("anthropic", 3);
  const steps = (process.env.WL_C_STEPS ?? "codeexec,html").split(",");
  let res: Awaited<ReturnType<typeof runCodeExec>> | undefined;
  let usedBeta = false;
  if (steps.includes("codeexec")) await s.step("code execution request (code_execution_20260521, no beta header)", async () => {
    res = await runCodeExec(s, false);
  });
  if (!res && steps.includes("codeexec")) {
    await s.step("code execution request retried WITH beta header code-execution-2025-08-25", async () => {
      res = await runCodeExec(s, true);
      usedBeta = true;
    });
  }
  s.note(`code execution beta header needed: ${usedBeta}`);
  if (res) {
    const { last, all } = res;
    s.save("code-exec-content.json", all);
    s.check("final stop_reason end_turn", last?.stop_reason === "end_turn", `${last?.stop_reason}`);
    const types = [...new Set(all.map((b) => b.type))];
    s.check("response has server_tool_use + bash/code execution result blocks", all.some((b) => b.type === "server_tool_use") && all.some((b) => /code_execution_tool_result/.test(b.type)), types.join(","));
    s.note(`usage: ${JSON.stringify(last?.usage)}`);
    s.note(`final text: ${textOf(last!.content as never).slice(0, 300).replace(/\s+/g, " ")}`);
    const ids = [...new Set([...JSON.stringify(all).matchAll(/"file_id":"(file_[A-Za-z0-9_-]+)"/g)].map((m) => m[1]))];
    s.check("code execution produced at least one file", ids.length > 0, ids.join(","));
    let pdfSaved = false;
    for (const id of ids) {
      const meta = await raw(`/v1/files/${id}`, { headers: { "anthropic-beta": "files-api-2025-04-14" } });
      const mj = (await meta.res.json().catch(() => ({}))) as { filename?: string; mime_type?: string; size_bytes?: number; downloadable?: boolean; error?: unknown };
      s.check(`GET /v1/files/${id} (metadata through the gateway)`, meta.res.status === 200, `HTTP ${meta.res.status} ${JSON.stringify(mj).slice(0, 200)}`);
      if (meta.res.status !== 200) s.bug(`Files metadata for a code-execution-produced file is refused by the gateway: GET /v1/files/${id} with anthropic-beta: files-api-2025-04-14 -> HTTP ${meta.res.status} ${JSON.stringify(mj).slice(0, 200)} (request id ${meta.rid}). Expected 200 (the file was produced by this customer's own /v1/messages call).`);
      const dl = await raw(`/v1/files/${id}/content`, { headers: { "anthropic-beta": "files-api-2025-04-14" } });
      const buf = Buffer.from(await dl.res.arrayBuffer());
      s.check(`GET /v1/files/${id}/content (download through the gateway)`, dl.res.status === 200 && buf.length > 0, `HTTP ${dl.res.status}, ${buf.length} bytes, content-type ${dl.res.headers.get("content-type")}, request ${dl.rid}`);
      if (dl.res.status !== 200) {
        s.bug(`Files download of a code-execution-produced file fails through the gateway: GET /v1/files/${id}/content (x-api-key + anthropic-beta files-api-2025-04-14) -> HTTP ${dl.res.status} ${buf.toString("utf8").slice(0, 200)} (request id ${dl.rid}).`);
        continue;
      }
      const name = mj.filename ?? id;
      const saved = s.save(path.basename(name), buf);
      if (buf.subarray(0, 4).toString() === "%PDF") {
        pdfSaved = true;
        const pages = await pdfPageCount(buf).catch(() => -1);
        s.check(`${name} is a valid PDF (%PDF header, page count)`, pages >= 4, `${pages} pages, ${buf.length} bytes -> ${saved}`);
      }
    }
    s.check("a PDF techpack was downloaded via /v1/files/{id}/content", pdfSaved);
  }

  // (2) local comparison: ask for HTML, render with headless Chrome
  if (steps.includes("html")) await s.step("fallback/comparison: Claude writes print HTML, Chrome headless renders a PDF locally", async () => {
    const c = anthropic();
    const m = await c.messages.stream({ model: "claude-sonnet-5-5", max_tokens: 32000, thinking: { type: "between_tools" }, output_config: { effort: "low" }, messages: [{ role: "user", content: `Create a complete multi-page (4+ pages, A4, use CSS @page and page-break-after) apparel techpack as ONE self-contained HTML document for the "Harbor Hoodie" (TP-2026-HD01): title block, inline SVG front/back flats, points-of-measure table (12 rows, sizes XS-XL), bill of materials (10 rows), construction notes (10 numbered), colorway swatches. Output only the HTML starting with <!DOCTYPE html>, no markdown fences.` }] } as never).finalMessage();
    let html = textOf(m.content as never);
    const i = html.search(/<!DOCTYPE html>/i);
    if (i > 0) html = html.slice(i);
    html = html.replace(/```\s*$/, "");
    const f = s.save("techpack-html/techpack.html", html);
    const pdf = path.join(path.dirname(f), "techpack-chrome.pdf");
    const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "/opt/pw-browsers/chromium", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((c) => !!c && fs.existsSync(c)) ?? "chrome";
    fs.rmSync(pdf, { force: true });
    const r = spawnSync(chrome, ["--headless=new", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${pdf}`, `file:///${f.replace(/\\/g, "/")}`], { encoding: "utf8", timeout: 120_000 });
    // headless=new can exit before the PDF is flushed: wait for the file size to settle
    for (let i = 0, last = -1; i < 40; i++) {
      const sz = fs.existsSync(pdf) ? fs.statSync(pdf).size : 0;
      if (sz > 0 && sz === last) break;
      last = sz;
      await new Promise((res) => setTimeout(res, 500));
    }
    s.check("headless Chrome produced a PDF", fs.existsSync(pdf), `exit ${r.status} ${(r.stderr ?? "").slice(-150)}`);
    if (fs.existsSync(pdf)) {
      s.artifacts.push(path.relative(ROOT, pdf).replace(/\\/g, "/"));
      const buf = fs.readFileSync(pdf);
      const pages = await pdfPageCount(buf).catch(() => -1);
      s.check("local PDF is valid with 4+ pages", buf.subarray(0, 4).toString() === "%PDF" && pages >= 4, `${pages} pages, ${buf.length} bytes`);
    }
    void extractSvg;
  });
}
