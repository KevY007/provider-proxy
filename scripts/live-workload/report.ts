/** Builds live-output/report-tables.md from live-output/results/*.json (+ DB spend). pnpm tsx scripts/live-workload/report.ts */
import fs from "node:fs";
import path from "node:path";
import { OUT, db, ctx, spendByProvider, usd, D, type ScenarioResult } from "./lib";

async function main() {
  const dir = path.join(OUT, "results");
  const res = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as ScenarioResult).sort((a, b) => a.id.localeCompare(b.id));
  const u = await db.user.findUniqueOrThrow({ where: { email: "workload@example.com" } });
  ctx.userId = u.id;
  ctx.providerSlug = new Map((await db.provider.findMany({ select: { id: true, slug: true } })).map((p) => [p.id, p.slug]));
  const spend = await spendByProvider();
  const price = await db.requestLog.aggregate({ where: { userId: u.id }, _sum: { price: true, cost: true, officialPrice: true }, _count: true });
  let md = "";
  md += "| Scenario | Result | Wall | Requests | Charged (price) | Our cost | Official | Checks failed |\n|---|---|---|---|---|---|---|---|\n";
  for (const r of res) md += `| ${r.id}. ${r.title} | **${r.status}** | ${(r.wallMs / 1000).toFixed(0)} s | ${r.requests.length} | ${usd(r.price)} | ${usd(r.cost)} | ${usd(r.official)} | ${r.checks.filter((c) => !c.ok).length}/${r.checks.length} |\n`;
  md += `\nTotals (all runs, customer workload@example.com): ${price._count} logged requests, charged ${usd(D(price._sum.price))}, our cost ${usd(D(price._sum.cost))}, official ${usd(D(price._sum.officialPrice))}.\n`;
  md += `\nEstimated upstream spend (sum of RequestLog.cost): ${Object.entries(spend).map(([k, v]) => `${k} ${usd(v)}`).join(", ")}\n`;
  for (const r of res) {
    md += `\n### ${r.id}. ${r.title} - ${r.status}\n\n`;
    const fails = r.checks.filter((c) => !c.ok);
    if (fails.length) md += "Failed checks:\n" + fails.map((c) => `- ${c.name}: ${c.note.slice(0, 300)}`).join("\n") + "\n\n";
    if (r.notes.length) md += "Notes:\n" + r.notes.map((n) => `- ${n.slice(0, 400)}`).join("\n") + "\n\n";
    const big = r.requests.filter((q) => q.inputTokens + q.outputTokens > 0).slice(0, 14);
    if (big.length) {
      md += "| request id | model | stream | in | out | cached | cache-write | price | cost | official | latency | ttft | queue |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|\n";
      for (const q of big) md += `| ${q.rid} | ${q.model} | ${q.stream ? "y" : "n"} | ${q.inputTokens} | ${q.outputTokens} | ${q.cachedTokens} | ${q.cacheWriteTokens} | ${usd(q.price)} | ${usd(q.cost)} | ${usd(q.officialPrice)} | ${q.latencyMs} ms | ${q.ttftMs ?? "-"} | ${q.queueMs} |\n`;
      if (r.requests.length > big.length) md += `\n(${r.requests.length} requests total; first ${big.length} usage-bearing rows shown)\n`;
    }
    if (r.artifacts.length) md += "\nArtifacts: " + r.artifacts.map((a) => "`" + a + "`").join(", ") + "\n";
  }
  fs.writeFileSync(path.join(OUT, "report-tables.md"), md);
  console.log(md.slice(0, 3000));
  await db.$disconnect();
}
main();
