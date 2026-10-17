/** Scenario H: the real Claude Code CLI pointed at the gateway. Runs only inside live-output/claude-code/<run>. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { BASE, ctx, db, guard, mkdir, OUT, Scn, tracked, raw } from "./lib";

const CLAUDE = process.env.CLAUDE_BIN ?? "C:/Users/rehab/.local/bin/claude.exe";

function runClaude(args: string[], prompt: string, cwd: string, configDir: string, timeoutMs: number, defaultEnv = false): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ANTHROPIC_BASE_URL: BASE,
      ANTHROPIC_AUTH_TOKEN: ctx.key,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CONFIG_DIR: configDir,
      ...(defaultEnv ? {} : { DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }),
    };
    // never leak the real LIVE_* secrets into the child
    for (const k of Object.keys(env)) if (k.startsWith("LIVE_") || k === "ENCRYPTION_KEY" || k === "SESSION_SECRET" || k === "DATABASE_URL") delete env[k];
    const p = spawn(CLAUDE, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(e), ms: Date.now() - t0 });
    });
    p.stdin.end(prompt);
  });
}

const TASK = `Create a small Python CLI called tp2json.py that converts a techpack measurement CSV (columns: pom,description,size,value_cm,tolerance_cm) into JSON grouped by pom. Use only the Python standard library (argparse, csv, json, unittest). Also create sample.csv with 6 rows and test_tp2json.py using unittest that checks the conversion. Then run the test with python -m unittest and tell me whether it passed.`;

export async function scenarioH(s: Scn) {
  await guard("anthropic", 3);
  const root = path.join(OUT, "claude-code");
  const work = path.join(root, "run-sonnet");
  const work2 = path.join(root, "run-haiku");
  const config = path.join(root, "config-dir");
  for (const d of [work, work2, config]) {
    fs.rmSync(d, { recursive: true, force: true });
    mkdir(d);
  }
  const v = await runClaude(["--version"], "", root, config, 30_000);
  s.note(`claude --version: ${v.stdout.trim()}`);
  s.check("claude CLI present", v.code === 0, v.stdout.trim());

  const since = new Date();
  const r = await runClaude(["-p", "--model", "claude-sonnet-5-5", "--dangerously-skip-permissions", "--max-turns", "15", "--output-format", "json"], TASK, work, config, 15 * 60_000);
  s.save("sonnet-stdout.json", r.stdout);
  s.save("sonnet-stderr.txt", r.stderr);
  s.note(`sonnet run: exit ${r.code} in ${(r.ms / 1000).toFixed(0)}s; stderr: ${r.stderr.slice(0, 300).replace(/\s+/g, " ")}`);
  let j: { is_error?: boolean; result?: string; num_turns?: number; total_cost_usd?: number; subtype?: string } = {};
  try {
    j = JSON.parse(r.stdout);
  } catch {
    s.note(`stdout is not JSON: ${r.stdout.slice(0, 300)}`);
  }
  s.check("claude -p exited 0 and reported success", r.code === 0 && j.is_error === false, `exit ${r.code} subtype=${j.subtype} is_error=${j.is_error} turns=${j.num_turns} result=${(j.result ?? "").slice(0, 160).replace(/\s+/g, " ")}`);
  const files = fs.readdirSync(work);
  s.note(`files created in the work dir: ${files.join(", ")}`);
  s.check("tp2json.py, sample.csv and test file were created", ["tp2json.py", "sample.csv"].every((f) => files.includes(f)) && files.some((f) => /^test.*\.py$/.test(f)), files.join(","));
  // verify the produced program independently
  const py = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn("python", ["-I", "-m", "unittest", "discover", "-s", work, "-p", "test*.py"], { cwd: work });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
  s.check("the generated unittest passes when re-run independently", py.code === 0, py.out.trim().split("\n").slice(-3).join(" | "));
  s.check("the agent said the test passed", /pass/i.test(j.result ?? ""), (j.result ?? "").slice(0, 120));

  const r2 = await runClaude(["-p", "--model", "claude-haiku-5-5", "--dangerously-skip-permissions", "--max-turns", "3", "--output-format", "json"], "In one short sentence: what does a tolerance column mean in a garment measurement table?", work2, config, 5 * 60_000);
  s.save("haiku-stdout.json", r2.stdout);
  let j2: { is_error?: boolean; result?: string } = {};
  try {
    j2 = JSON.parse(r2.stdout);
  } catch {
    /* ignore */
  }
  s.check("claude-haiku-5-5 quick prompt answered", r2.code === 0 && j2.is_error === false && (j2.result ?? "").length > 10, `exit ${r2.code} ${(j2.result ?? r2.stdout).slice(0, 120)} ${r2.stderr.slice(0, 150)}`);

  // run with Claude Code's DEFAULT env (no telemetry/nonessential-traffic switches, no model override for its background model)
  const work3 = path.join(root, "run-default-env");
  fs.rmSync(work3, { recursive: true, force: true });
  mkdir(work3);
  const t3 = new Date();
  const r4 = await runClaude(["-p", "--dangerously-skip-permissions", "--max-turns", "3", "--output-format", "json"], "Create a file hello.txt containing the word hello, then say done.", work3, config, 5 * 60_000, true);
  s.save("default-env-stdout.json", r4.stdout);
  let j4: { is_error?: boolean; result?: string } = {};
  try {
    j4 = JSON.parse(r4.stdout);
  } catch {
    /* ignore */
  }
  await new Promise((res) => setTimeout(res, 2500));
  const l4 = await db.requestLog.findMany({ where: { userId: ctx.userId, createdAt: { gte: t3 } } });
  s.note(`default-env run (no --model, CLI picks its own default + background models): exit ${r4.code}, is_error=${j4.is_error}, result=${(j4.result ?? r4.stdout).slice(0, 100).replace(/\s+/g, " ")}; requests: ${[...new Set(l4.map((l) => `${l.modelSlug ?? "?"}:${l.httpStatus}`))].join(", ")}; stderr: ${r4.stderr.slice(0, 200)}`);
  s.check("Claude Code with its default env + default models works through the gateway", r4.code === 0 && j4.is_error === false && fs.existsSync(path.join(work3, "hello.txt")), `exit ${r4.code} is_error=${j4.is_error}; failures: ${l4.filter((l) => l.status !== "SUCCESS").map((l) => `${l.modelSlug ?? "?"} ${l.httpStatus} ${l.errorCode}`).join("; ") || "none"}`);
  const dflt = l4.filter((l) => /claude/i.test(l.userAgent ?? ""));
  s.check("no model_not_found among Claude Code's own default-env requests", dflt.every((l) => l.errorCode !== "model_not_found"), dflt.filter((l) => l.errorCode === "model_not_found").map((l) => `${l.httpStatus} ${l.errorMessage}`).slice(0, 2).join("; "));

  // Claude Code's built-in background model id is dated (claude-haiku-4-5-20251001): does the gateway accept it?
  for (const id of ["claude-haiku-4-5-20251001", "claude-sonnet-5-5-20260101"]) {
    const r3 = await raw("/v1/messages", { body: { model: id, max_tokens: 16, messages: [{ role: "user", content: "Reply: ok" }] } });
    const t3 = await r3.res.text();
    s.note(`direct call with model id ${id}: HTTP ${r3.res.status} ${t3.slice(0, 140)}`);
    if (id.startsWith("claude-haiku-4-5")) s.check(`dated Claude Code default small model id (${id}) is accepted`, r3.res.status === 200, `HTTP ${r3.res.status} ${t3.slice(0, 120)}`);
  }

  // the CLI does not use our tracked fetch: pull its requests from the RequestLog
  await new Promise((res) => setTimeout(res, 2500));
  const logs = await db.requestLog.findMany({ where: { userId: ctx.userId, createdAt: { gte: since } }, orderBy: { createdAt: "asc" } });
  for (const l of logs) tracked.push({ scenario: s.id, rid: l.id, method: "POST", path: l.endpoint, status: l.httpStatus, headersMs: 0, at: Date.now() });
  const byModel = new Map<string, { n: number; ok: number; bad: string[] }>();
  for (const l of logs) {
    const k = `${l.modelSlug ?? "?"} ${l.endpoint}`;
    const e = byModel.get(k) ?? { n: 0, ok: 0, bad: [] };
    e.n++;
    if (l.status === "SUCCESS") e.ok++;
    else e.bad.push(`${l.httpStatus} ${l.errorCode ?? ""}`);
    byModel.set(k, e);
  }
  for (const [k, e] of byModel) s.note(`RequestLog: ${k}: ${e.n} requests, ${e.ok} SUCCESS${e.bad.length ? `, failures: ${[...new Set(e.bad)].join("; ")}` : ""}`);
  const sonnet = logs.filter((l) => l.modelSlug === "claude-sonnet-5-5" && l.endpoint.startsWith("/v1/messages"));
  s.check("Claude Code's /v1/messages requests are in the RequestLog (sonnet)", sonnet.length >= 3, `${sonnet.length} sonnet requests`);
  s.check("agent loop requests were streamed", sonnet.filter((l) => l.stream).length >= 1, `${sonnet.filter((l) => l.stream).length}/${sonnet.length} streamed`);
  const failures = logs.filter((l) => /claude/i.test(l.userAgent ?? "") && l.status !== "SUCCESS" && l.createdAt < t3);
  s.check("no failed requests from Claude Code (any model)", failures.length === 0, failures.map((l) => `${l.modelSlug} ${l.endpoint} ${l.httpStatus} ${l.errorCode}`).slice(0, 4).join("; "));
  const cacheHits = sonnet.reduce((a, l) => a + l.cachedTokens, 0);
  s.note(`Claude Code prompt caching through the gateway: ${cacheHits} cached tokens across ${sonnet.length} sonnet requests; total cost reported by CLI: ${j.total_cost_usd}`);
}
