/**
 * Live workload runner.   pnpm tsx scripts/live-workload/run.ts [--only B,C] [--skip H]
 * Needs: dev server on WL_BASE_URL (default http://localhost:3011), `pnpm setup:live` done once.
 * Results: live-output/results/<id>.json, artifacts under live-output/<id>/, summary table at the end.
 */
import { init, results, runScenario, spendLine, spendByProvider, db, usd, ctx, BASE, mkdir, OUT, type ScenarioResult } from "./lib";
import { scenarioA, scenarioB, scenarioK } from "./s-chat";

const SCENARIOS: Array<{ id: string; title: string; load: () => Promise<(s: import("./lib").Scn) => Promise<void>> }> = [
  { id: "A", title: "Chat like a real user (Anthropic native, SDK, multi-turn, streaming, 4 models)", load: async () => scenarioA },
  { id: "L", title: "PRIORITY: reference image + instructions -> one SVG techpack with garment flats (gpt-6-astra chat+responses, Claude)", load: async () => (await import("./s-openai")).scenarioL },
  { id: "B", title: "Techpack as a single SVG (sonnet-5-5 + opus-5-5, streamed, rendered to PNG)", load: async () => scenarioB },
  { id: "C", title: "Techpack as PDF via code execution + Files API download through the gateway", load: async () => (await import("./s-pdf")).scenarioC },
  { id: "D", title: "Agentic features (thinking + tool loop, web search, code exec, caching, PDF/image input)", load: async () => (await import("./s-agentic")).scenarioD },
  { id: "E", title: "Long context (~150k tokens, needle)", load: async () => (await import("./s-agentic")).scenarioE },
  { id: "F", title: "Concurrency (50 parallel streams)", load: async () => (await import("./s-misc")).scenarioF },
  { id: "G", title: "Translation path: OpenAI SDK -> /v1/chat/completions -> Claude", load: async () => (await import("./s-misc")).scenarioG },
  { id: "H", title: "Real Claude Code CLI through the gateway", load: async () => (await import("./s-claude-code")).scenarioH },
  { id: "I", title: "OpenAI models (Responses+tools, chat stream, image, embeddings, files)", load: async () => (await import("./s-openai")).scenarioI },
  { id: "J", title: "Customer-facing views (logs, usage, savings)", load: async () => (await import("./s-views")).scenarioJ },
  { id: "K", title: "Anthropic Message Batches through the gateway", load: async () => scenarioK },
];

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean) : null;
};
const only = arg("--only");
const skip = arg("--skip") ?? [];

async function main() {
  mkdir(OUT);
  const warm = await fetch(`${BASE}/v1/models`).catch((e) => {
    throw new Error(`cannot reach ${BASE}: ${e.message}. Start: NEXT_DIST_DIR=.next-workload pnpm next dev -p 3011`);
  });
  await warm.arrayBuffer();
  await init();
  console.log(`Live workload against ${BASE} as ${"workload@example.com"} | spend so far: ${(await spendLine()) || "none"}`);
  for (const sc of SCENARIOS) {
    if (only && !only.includes(sc.id)) continue;
    if (skip.includes(sc.id)) continue;
    const fn = await sc.load();
    await runScenario(sc.id, sc.title, fn);
  }
  console.log("\n" + "=".repeat(100));
  for (const r of results as ScenarioResult[]) {
    console.log(`${r.id.padEnd(3)} ${r.status.padEnd(5)} ${(r.wallMs / 1000).toFixed(0).padStart(5)}s  req ${String(r.requests.length).padStart(3)}  price ${usd(r.price).padStart(9)}  cost ${usd(r.cost).padStart(9)}  official ${usd(r.official).padStart(9)}  ${r.title.slice(0, 50)}`);
  }
  const s = await spendByProvider();
  console.log("\nTotal estimated upstream spend (all runs): " + Object.entries(s).map(([k, v]) => `${k} ${usd(v)}`).join(" | "));
  void ctx;
}

main()
  .then(async () => {
    await db.$disconnect();
    process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
  })
  .catch(async (e) => {
    console.error("FATAL:", e instanceof Error ? e.message : e);
    await db.$disconnect();
    process.exit(2);
  });
