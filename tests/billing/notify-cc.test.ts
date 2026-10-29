import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dbOk } from "../gateway/harness";
import { requestPasswordReset } from "@/lib/auth/service";
import { db } from "@/lib/db";
import { NOTIFY_CC_MAX, parseNotifyCc } from "@/lib/notify-cc";
import { invalidateSettingsCache, setSettings } from "@/lib/settings";
import { customerSettingsSchema } from "@/server/admin/customers-calc";
import { alertLowBalances } from "@/server/admin/upstream-balances";
import { maybeSendLowBalanceAlert } from "@/server/billing/auto-recharge";
import { __resetLocks } from "@/server/billing/locks";

const tag = () => randomBytes(5).toString("hex");

describe("notification copies validation", () => {
  it("trims, lowercases and de-duplicates; accepts one address per line", () => {
    expect(parseNotifyCc("  Team@Example.com \n\nteam@example.com\nbilling@example.com ")).toEqual({ ok: true, value: ["team@example.com", "billing@example.com"] });
    expect(parseNotifyCc(["a@example.com", " A@EXAMPLE.COM"])).toEqual({ ok: true, value: ["a@example.com"] });
    expect(parseNotifyCc("")).toEqual({ ok: true, value: [] });
  });

  it("rejects a bad address, the account's own address and more than 10", () => {
    expect(parseNotifyCc("ok@example.com\nnot-an-email").ok).toBe(false);
    expect(parseNotifyCc(["owner@example.com"], "Owner@Example.com").ok).toBe(false);
    const eleven = Array.from({ length: NOTIFY_CC_MAX + 1 }, (_, i) => `p${i}@example.com`);
    expect(parseNotifyCc(eleven).ok).toBe(false);
    expect(parseNotifyCc(eleven.slice(0, NOTIFY_CC_MAX)).ok).toBe(true);
  });

  it("the admin customer settings schema validates the list and leaves it unchanged when omitted", () => {
    const base = { userId: "u", billingMode: "PREPAID" as const, priceMultiplier: "", creditLimit: "", monthlySpendLimit: "", maxConcurrency: "" };
    expect(customerSettingsSchema.parse(base).notifyCc).toBeUndefined();
    expect(customerSettingsSchema.parse({ ...base, notifyCc: "X@example.com\nx@example.com" }).notifyCc).toEqual(["x@example.com"]);
    const bad = customerSettingsSchema.safeParse({ ...base, notifyCc: "nope" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(["notifyCc"]);
  });
});

describe.skipIf(!dbOk)("notification copies (EmailOutbox)", () => {
  const userIds: string[] = [];
  const settingKeys = ["upstreamBalanceAlerted", "upstreamBalanceLowUsd", "lowBalanceEmail"];
  let savedSettings: Array<{ key: string; value: unknown }> = [];
  const makeUser = async (data: { balance?: string; role?: "ADMIN" | "CUSTOMER"; notifyCc?: string[] } = {}) => {
    const u = await db.user.create({ data: { email: `notify-${tag()}@example.com`, passwordHash: "x", status: "ACTIVE", ...data } });
    userIds.push(u.id);
    return u;
  };
  const outboxFor = (to: string) => db.emailOutbox.findMany({ where: { to }, select: { subject: true, bcc: true } });

  beforeAll(async () => {
    savedSettings = (await db.setting.findMany({ where: { key: { in: settingKeys } } })).map((s) => ({ key: s.key, value: s.value }));
    await setSettings({ lowBalanceEmail: true });
  });
  beforeEach(() => __resetLocks());
  afterAll(async () => {
    const emails = (await db.user.findMany({ where: { id: { in: userIds } }, select: { email: true } })).map((u) => u.email);
    await db.emailOutbox.deleteMany({ where: { to: { in: emails } } });
    await db.auditLog.deleteMany({ where: { OR: [{ targetId: { in: userIds } }, { actorId: { in: userIds } }] } });
    await db.verificationToken.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.setting.deleteMany({ where: { key: { in: settingKeys } } });
    for (const s of savedSettings) await db.setting.create({ data: { key: s.key, value: s.value as never } });
    invalidateSettingsCache();
  });

  it("the low-balance alert reaches the BCC addresses", async () => {
    const u = await makeUser({ balance: "1", notifyCc: ["copy-a@example.com", "copy-b@example.com"] });
    await maybeSendLowBalanceAlert(u.id);
    const sent = await outboxFor(u.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/running low/);
    expect(sent[0]!.bcc).toEqual(["copy-a@example.com", "copy-b@example.com"]);
  });

  it("the balance-exhausted alert reaches the BCC addresses", async () => {
    const u = await makeUser({ balance: "0", notifyCc: ["copy-z@example.com"] });
    await maybeSendLowBalanceAlert(u.id);
    const sent = await outboxFor(u.email);
    expect(sent.map((s) => [s.subject.includes("run out"), s.bcc])).toEqual([[true, ["copy-z@example.com"]]]);
  });

  it("a password-reset email does NOT go to the copies", async () => {
    const u = await makeUser({ notifyCc: ["copy-c@example.com"] });
    await requestPasswordReset(u.email, `203.0.113.${Math.floor(Math.random() * 200) + 1}`);
    const sent = await outboxFor(u.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toMatch(/Reset your/);
    expect(sent[0]!.bcc).toEqual([]);
    expect(await db.emailOutbox.count({ where: { bcc: { has: "copy-c@example.com" } } })).toBe(0);
  });

  it("the upstream low-balance alert copies each admin's own list", async () => {
    const a1 = await makeUser({ role: "ADMIN", notifyCc: ["ops-1@example.com"] });
    const a2 = await makeUser({ role: "ADMIN" });
    await db.setting.upsert({ where: { key: "upstreamBalanceLowUsd" }, create: { key: "upstreamBalanceLowUsd", value: 10 }, update: { value: 10 } });
    await db.setting.deleteMany({ where: { key: "upstreamBalanceAlerted" } });
    invalidateSettingsCache();
    const id = `acct-notify-${tag()}`;
    const name = `Notify test ${id}`;
    expect(await alertLowBalances({ at: new Date().toISOString(), accounts: [{ id, name, balance: 2, keys: [], providers: [] }] })).toEqual([id]);
    expect((await outboxFor(a1.email)).map((s) => s.bcc)).toEqual([["ops-1@example.com"]]);
    expect((await outboxFor(a2.email)).map((s) => s.bcc)).toEqual([[]]);
    await db.auditLog.deleteMany({ where: { targetType: "UpstreamAccount", targetId: id } });
    await db.emailOutbox.deleteMany({ where: { subject: { contains: name } } }); // also the copies to other local admins
  });
});
