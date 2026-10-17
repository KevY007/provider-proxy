/**
 * Shared fixture harness for the database-backed gateway tests: boots the mock upstream in-process and creates
 * uniquely named users / keys / providers / models, all removed again by `cleanup()`. Skipped by callers when the
 * database is unreachable (`dbOk`).
 */
import { expect } from "vitest";
import { startMockUpstream } from "../../scripts/mock-upstream";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { handle } from "@/gateway/handle";
import { flushMeter } from "@/gateway/meter-writer";
import { encrypt, sha256 } from "@/lib/crypto";
import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";

export const dbOk = await db.$queryRaw`SELECT 1`.then(
  () => true,
  () => false,
);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Mock = Awaited<ReturnType<typeof startMockUpstream>>;

export function createHarness(tag: string) {
  const sfx = String(Math.floor(Math.random() * 1e8)).padStart(8, "0"); // digits only: mock keys containing "bad"/"slow"/"fail" trigger faults
  const name = (s: string) => `${tag}-${s}-${sfx}`;
  const secret = (s: string) => `${tag}-key-${s}-${sfx}`;
  const apiKey = (t: string) => `sk-pp-${tag}${t}${sfx}`.padEnd(46, "0");
  const ids = { users: [] as string[], keys: [] as string[], providers: [] as string[], models: [] as string[], groups: [] as string[], logs: [] as string[] };
  const h = {
    sfx,
    name,
    secret,
    ids,
    mock: null as unknown as Mock,
    base: "",
    groupId: "",

    async start(): Promise<void> {
      h.mock = await startMockUpstream(0, "127.0.0.1");
      h.base = `http://127.0.0.1:${h.mock.port}`;
      const g = await db.group.create({ data: { name: name("g"), slug: name("g"), priceMultiplier: "1", providerTags: [`iso-${sfx}`] } });
      ids.groups.push(g.id);
      h.groupId = g.id;
    },

    async cleanup(): Promise<void> {
      try {
        await flushMeter();
      } catch {
        /* ignore */
      }
      await db.requestLog.deleteMany({ where: { OR: [{ id: { in: ids.logs } }, { userId: { in: ids.users } }] } }).catch(() => undefined);
      await db.videoJob.deleteMany({ where: { userId: { in: ids.users } } }).catch(() => undefined);
      await db.apiKey.deleteMany({ where: { id: { in: ids.keys } } }).catch(() => undefined);
      await db.modelRoute.deleteMany({ where: { modelId: { in: ids.models } } }).catch(() => undefined);
      await db.model.deleteMany({ where: { id: { in: ids.models } } }).catch(() => undefined);
      await db.provider.deleteMany({ where: { id: { in: ids.providers } } }).catch(() => undefined);
      await db.user.deleteMany({ where: { id: { in: ids.users } } }).catch(() => undefined);
      await db.group.deleteMany({ where: { id: { in: ids.groups } } }).catch(() => undefined);
      await invalidateGatewayConfig("all");
      await h.mock?.close();
    },

    async makeUser(t: string, o: { balance?: string; creditLimit?: string; priceMultiplier?: string; monthlySpendLimit?: string; groupId?: string } = {}) {
      const u = await db.user.create({
        data: {
          email: `${name(t)}@test.local`,
          passwordHash: "x",
          status: "ACTIVE",
          emailVerifiedAt: new Date(),
          balance: o.balance ?? "10",
          creditLimit: o.creditLimit ?? "0",
          groupId: o.groupId ?? h.groupId,
          priceMultiplier: o.priceMultiplier ?? null,
          monthlySpendLimit: o.monthlySpendLimit ?? null,
        },
      });
      ids.users.push(u.id);
      return u;
    },

    async makeKey(t: string, userId: string, o: Record<string, unknown> = {}) {
      const key = apiKey(t);
      const k = await db.apiKey.create({ data: { userId, name: name(t), prefix: key.slice(0, 12), keyHash: sha256(key), ...o } });
      ids.keys.push(k.id);
      return { userId, key, keyId: k.id };
    },

    async makeProvider(t: string, o: { formats: string[]; baseUrl?: string; authStyle?: "BEARER" | "X_API_KEY"; settings?: object; preset?: string; keys: Array<{ s: string; priority?: number; maxConcurrency?: number }> }) {
      const p = await db.provider.create({
        data: {
          name: name(t),
          slug: name(t),
          preset: o.preset ?? "custom",
          baseUrl: o.baseUrl ?? `${h.base}/v1`,
          authStyle: o.authStyle ?? "BEARER",
          formats: o.formats,
          tags: ["mock", `iso-${sfx}`], // iso-<sfx> + the harness group's providerTags keep parallel test files off each other's providers (Files calls pick ANY provider speaking the format)
          settings: o.settings ?? {},
          timeoutMs: 30_000,
        },
      });
      ids.providers.push(p.id);
      const keys: string[] = [];
      for (const k of o.keys) {
        const pk = await db.providerKey.create({ data: { providerId: p.id, label: `${t}-${k.s}`, secretEncrypted: encrypt(secret(k.s)), secretHint: "test", priority: k.priority ?? 0, maxConcurrency: k.maxConcurrency } });
        keys.push(pk.id);
      }
      return { id: p.id, keys };
    },

    async makeModel(
      t: string,
      o: {
        caps: string[];
        providerId: string;
        upstream?: string;
        in?: string;
        out?: string;
        cached?: string;
        image?: string;
        perSecond?: string;
        maxOutput?: number | null;
        official?: Record<string, string | null>;
        route?: Record<string, unknown>;
        cost?: Record<string, unknown>;
        model?: Record<string, unknown>;
      },
    ) {
      const slug = name(t);
      const m = await db.model.create({
        data: {
          slug,
          displayName: slug,
          vendor: "gwt",
          capabilities: o.caps,
          maxOutput: o.maxOutput ?? null,
          inputPrice: o.in ?? "3",
          outputPrice: o.out ?? "15",
          cachedInputPrice: o.cached ?? null,
          imagePrice: o.image ?? null,
          perSecondPrice: o.perSecond ?? null,
          ...(o.official ?? {}),
          ...(o.model ?? {}),
        },
      });
      ids.models.push(m.id);
      await db.modelRoute.create({
        data: { modelId: m.id, providerId: o.providerId, upstreamModel: o.upstream ?? `up-${t}`, inputCost: "1.5", outputCost: "7.5", imageCost: o.image ? "0.02" : null, perSecondCost: o.perSecond ? "0.05" : null, ...o.cost, ...o.route },
      });
      return { slug, id: m.id };
    },

    async call(path: string, key: string | null, body?: unknown, o: { method?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
      const headers: Record<string, string> = { ...(body !== undefined && !(body instanceof FormData) ? { "content-type": "application/json" } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}), ...o.headers };
      const res = await handle(
        new Request(`http://gateway.test${path}`, {
          method: o.method ?? (body === undefined ? "GET" : "POST"),
          headers,
          body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
          signal: o.signal,
        }),
      );
      const id = res.headers.get("x-request-id");
      expect(id, "every response carries x-request-id").toBeTruthy();
      ids.logs.push(id!);
      return res;
    },

    /** The RequestLog of a response (streams finalize asynchronously after the body ends, so poll briefly). */
    async logOf(res: Response) {
      const id = res.headers.get("x-request-id")!;
      for (let i = 0; i < 150; i++) {
        await flushMeter();
        const row = await db.requestLog.findUnique({ where: { id } });
        if (row) return row;
        await sleep(20);
      }
      return db.requestLog.findUniqueOrThrow({ where: { id } });
    },

    async balanceOf(userId: string): Promise<Decimal> {
      await flushMeter();
      return new Decimal((await db.user.findUniqueOrThrow({ where: { id: userId } })).balance.toString());
    },
  };
  return h;
}

/** Parse an SSE body into {event, data} blocks. */
export function sseBlocks(text: string) {
  return text
    .split(/\n\n/)
    .filter((b) => b.trim())
    .map((b) => {
      const event = /^event: (.*)$/m.exec(b)?.[1];
      const data = b
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      return { event, data };
    });
}
