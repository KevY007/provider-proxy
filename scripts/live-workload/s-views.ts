/** Scenario J: what the customer dashboard would show for this workload (real pages fetched with a DB-created session). */
import { Decimal, D, db, ctx, Scn, usd } from "./lib";
import { randomToken, sha256 } from "../../src/lib/crypto";
import { BASE } from "./lib";

export async function scenarioJ(s: Scn) {
  const token = randomToken(32);
  await db.session.create({ data: { id: sha256(token), userId: ctx.userId, expiresAt: new Date(Date.now() + 3_600_000), twoFactorPassed: true, userAgent: "live-workload" } });
  const get = async (p: string) => {
    const res = await fetch(BASE + p, { headers: { cookie: `pp_session=${token}` }, redirect: "manual" });
    return { res, text: await res.text() };
  };
  try {
    const agg = await db.requestLog.aggregate({ where: { userId: ctx.userId }, _sum: { price: true, cost: true, profit: true, officialPrice: true }, _count: true });
    const byModel = await db.requestLog.groupBy({ by: ["modelSlug"], where: { userId: ctx.userId }, _sum: { price: true, officialPrice: true, cost: true, inputTokens: true, outputTokens: true, cachedTokens: true }, _count: true, orderBy: { _sum: { price: "desc" } } });
    const price = D(agg._sum.price);
    const official = D(agg._sum.officialPrice);
    const cost = D(agg._sum.cost);
    s.note(`all-time for workload@example.com: ${agg._count} requests, charged ${usd(price)}, our cost ${usd(cost)}, official ${usd(official)}, profit ${usd(D(agg._sum.profit))}`);
    const saved = official.minus(price);
    s.note(`savings vs official (official - charged) = ${usd(saved)} (${official.isZero() ? "n/a" : saved.div(official).times(100).toFixed(1)}%) -> customers pay ${saved.isNegative() ? "MORE" : "less"} than the maker's list price`);
    for (const m of byModel) s.note(`  ${String(m.modelSlug).padEnd(22)} n=${String(m._count).padStart(4)} charged ${usd(D(m._sum.price)).padStart(10)} official ${usd(D(m._sum.officialPrice)).padStart(10)} in=${m._sum.inputTokens} out=${m._sum.outputTokens} cached=${m._sum.cachedTokens}`);
    s.save("j-by-model.json", byModel);

    const ledger = await db.ledgerEntry.aggregate({ where: { userId: ctx.userId, type: { not: "ADJUSTMENT" } }, _sum: { amount: true } });
    const u = await db.user.findUniqueOrThrow({ where: { id: ctx.userId }, select: { balance: true } });
    s.note(`balance now ${usd(D(u.balance))}; non-adjustment ledger sum ${usd(D(ledger._sum.amount))}`);

    for (const p of ["/dashboard", "/dashboard/logs", "/dashboard/usage", "/dashboard/models", "/dashboard/keys", "/dashboard/billing"]) {
      const r = await get(p);
      s.check(`GET ${p} renders for the customer (200)`, r.res.status === 200, `HTTP ${r.res.status} ${r.res.headers.get("location") ?? ""}, ${(r.text.length / 1024).toFixed(0)} KiB`);
      if (p === "/dashboard/logs") {
        s.check("logs page lists models from this run", /claude-sonnet-5-5|claude-haiku-5-5/.test(r.text), "");
        s.save("dashboard-logs.html", r.text);
      }
      if (p === "/dashboard") {
        s.save("dashboard-overview.html", r.text);
        const m = r.text.match(/>([+-]?\$[\d.,]+)<\/p><p[^>]*>([^<]*(?:official|saved)[^<]*)</i);
        s.note(`dashboard overview savings card renders: "${m ? `${m[1]} ${m[2]}` : "(savings text not found)"}"`);
        s.check("dashboard overview shows the savings-vs-official card", /Your savings vs official prices/.test(r.text) && !!m, m ? `${m[1]} ${m[2]}` : "");
      }
    }
    const csv = await get("/dashboard/logs/export?range=all");
    s.check("GET /dashboard/logs/export (CSV)", csv.res.status === 200 && csv.text.startsWith("time_utc"), `HTTP ${csv.res.status}`);
    if (csv.res.status === 200) {
      s.save("logs-export.csv", csv.text);
      const lines = csv.text.trim().split(/\r?\n/);
      const header = lines[0].split(",");
      const iC = header.indexOf("charged_usd");
      const iO = header.indexOf("official_usd");
      const iS = header.indexOf("saved_usd");
      let sc = new Decimal(0);
      let so = new Decimal(0);
      let ss = new Decimal(0);
      for (const l of lines.slice(1)) {
        const cols = l.split(",");
        sc = sc.plus(cols[iC] || 0);
        so = so.plus(cols[iO] || 0);
        ss = ss.plus(cols[iS] || 0);
      }
      s.note(`CSV export: ${lines.length - 1} rows; charged ${usd(sc)}, official ${usd(so)}, saved_usd column sums to ${usd(ss)}`);
      s.check("CSV has official/charged/saved columns", iC > 0 && iO > 0 && iS > 0, header.join(","));
      s.check("CSV charged total == DB total (within 1e-4, 50k-row cap / rounding)", sc.minus(price).abs().lte(0.0001) || lines.length - 1 >= 50_000, `${usd(sc)} vs ${usd(price)}`);
    }
  } finally {
    await db.session.delete({ where: { id: sha256(token) } }).catch(() => undefined);
  }
}
