/** Which pools a customer may put a key in: public, their own, admin-allowed private pools, or the key's current pool. */
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { db } from "@/lib/db";
import { canUsePool } from "@/server/customer/key-schemas";
import { getSelectablePools } from "@/server/customer/portal-data";
import type { SessionUser } from "@/lib/auth/types";

describe("canUsePool", () => {
  const user = { groupId: "own", extraGroupIds: ["allowed"] };
  it("public, own and admin-allowed pools are open; other private pools are not", () => {
    expect(canUsePool({ id: "pub", isPublic: true }, user)).toBe(true);
    expect(canUsePool({ id: "own", isPublic: false }, user)).toBe(true);
    expect(canUsePool({ id: "allowed", isPublic: false }, user)).toBe(true);
    expect(canUsePool({ id: "secret", isPublic: false }, user)).toBe(false);
    expect(canUsePool({ id: "secret", isPublic: false }, { groupId: null })).toBe(false);
  });
  it("editing a key may keep the private pool it is already in", () => {
    expect(canUsePool({ id: "secret", isPublic: false }, user, "secret")).toBe(true);
  });
});

const dbOk = await db.$queryRaw`SELECT 1`.then(
  () => true,
  () => false,
);
const sfx = Math.random().toString(36).slice(2, 8);

describe.skipIf(!dbOk)("getSelectablePools", () => {
  const ids: { groups: string[]; users: string[] } = { groups: [], users: [] };
  afterAll(async () => {
    await db.apiKey.deleteMany({ where: { userId: { in: ids.users } } });
    await db.user.deleteMany({ where: { id: { in: ids.users } } });
    await db.group.deleteMany({ where: { id: { in: ids.groups } } });
  });

  it("lists admin-allowed private pools and the pools of existing keys, never other private pools", async () => {
    const mk = async (t: string) => {
      const g = await db.group.create({ data: { name: `kp-${t}-${sfx}`, slug: `kp-${t}-${sfx}`, isPublic: false } });
      ids.groups.push(g.id);
      return g;
    };
    const [allowed, keyed, secret] = [await mk("allowed"), await mk("keyed"), await mk("secret")];
    const u = await db.user.create({ data: { email: `kp-${sfx}@example.com`, passwordHash: "!", status: "ACTIVE", extraGroupIds: [allowed.id] } });
    ids.users.push(u.id);
    await db.apiKey.create({ data: { userId: u.id, name: "k", prefix: `sk-pp-${sfx}`, keyHash: `kp-hash-${sfx}`, groupId: keyed.id } });
    const { pools } = await getSelectablePools(u as unknown as SessionUser);
    const got = new Set(pools.map((p) => p.id));
    expect(got.has(allowed.id)).toBe(true);
    expect(got.has(keyed.id)).toBe(true);
    expect(got.has(secret.id)).toBe(false);
  });
});
