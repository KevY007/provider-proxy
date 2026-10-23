/** Spend per pool next to the same usage at official list prices (dashboard), and per key (API keys page). */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { db } from "@/lib/db";
import { getSpendByPool } from "@/server/customer/savings-totals";

const dbOk = await db.$queryRaw`SELECT 1`.then(
  () => true,
  () => false,
);
const sfx = Math.random().toString(36).slice(2, 8);

describe.skipIf(!dbOk)("getSpendByPool", () => {
  const ids: { users: string[]; groups: string[] } = { users: [], groups: [] };
  afterAll(async () => {
    await db.requestLog.deleteMany({ where: { userId: { in: ids.users } } });
    await db.user.deleteMany({ where: { id: { in: ids.users } } });
    await db.group.deleteMany({ where: { id: { in: ids.groups } } });
  });

  it("groups billed requests by pool with spend, list price and the comparable part", async () => {
    const g = await db.group.create({ data: { name: `Studio ${sfx}`, slug: `studio-${sfx}`, priceMultiplier: "0.3" } });
    ids.groups.push(g.id);
    const u = await db.user.create({ data: { email: `pool-${sfx}@example.com`, passwordHash: "!", status: "ACTIVE" } });
    ids.users.push(u.id);
    const log = (slug: string | null, price: string, official: string) =>
      db.requestLog.create({ data: { userId: u.id, groupSlug: slug, endpoint: "/v1/responses", inboundFormat: "openai_responses", status: "SUCCESS", httpStatus: 200, price, officialPrice: official } });
    await log(g.slug, "0.30", "1.00");
    await log(g.slug, "0.60", "2.00");
    await log(g.slug, "0.10", "0"); // no list price recorded: spend only
    const gone = `deleted-pool-${sfx}`; // a pool that no longer exists: shown by its slug
    await log(gone, "5.00", "5.00");
    await log(gone, "0", "0"); // not billed: left out
    const rows = await getSpendByPool(u.id);
    expect(rows.map((r) => r.slug)).toEqual([`deleted-pool-${sfx}`, g.slug]);
    const studio = rows.find((r) => r.slug === g.slug)!;
    expect(studio).toMatchObject({ name: `Studio ${sfx}`, requests: 3 });
    expect(studio.spent).toBeCloseTo(1.0);
    expect(studio.listPrice).toBeCloseTo(3.0);
    expect(studio.comparablePaid).toBeCloseTo(0.9);
    expect(rows.find((r) => r.slug === `deleted-pool-${sfx}`)).toMatchObject({ name: `deleted-pool-${sfx}`, requests: 1, spent: 5, listPrice: 5 });
  });
});
