import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PRICING_TARGETS, pricingTargetsSchema, unavailablePricingTarget } from "@/server/pricing/price-sync/targets";
import { askPricingAi } from "@/server/pricing/price-sync/ai";

const targets = [{ pool: "first", model: "m1" }, { pool: "second", model: "m2" }, { pool: "third", model: "m3" }];
const mocks = vi.hoisted(() => ({
  settings: vi.fn(), group: vi.fn(), createKey: vi.fn(), deleteKeys: vi.fn(), gateway: vi.fn<(req: Request) => Promise<Response>>(), flush: vi.fn(),
}));
vi.mock("@/lib/settings", () => ({ getSettings: mocks.settings }));
vi.mock("@/lib/db", () => ({ db: {
  group: { findUnique: mocks.group }, user: { findUnique: async () => ({ id: "bot", groupId: "first" }), update: vi.fn() },
  apiKey: { create: mocks.createKey, deleteMany: mocks.deleteKeys },
} }));
vi.mock("@/gateway/cache", () => ({ invalidateGatewayConfig: vi.fn() }));
vi.mock("@/gateway/handle", () => ({ handle: mocks.gateway }));
vi.mock("@/gateway/meter-writer", () => ({ flushMeter: mocks.flush }));

const response = (content: string, id: string) => Response.json({ choices: [{ message: { content } }] }, { headers: { "x-request-id": id } });

describe("pricing route settings", () => {
  it("requires a bounded nonempty list of distinct complete pairs", () => {
    for (const bad of [null, [], [targets[0], { pool: " first", model: "m1" }], [{ pool: " ", model: "m" }], [{ pool: "a" }],
      Array.from({ length: MAX_PRICING_TARGETS + 1 }, (_, i) => ({ pool: "a", model: `m${i}` }))]) {
      expect(pricingTargetsSchema.safeParse(bad).success).toBe(false);
    }
    expect(pricingTargetsSchema.parse(targets)).toEqual(targets);
  });
  it("validates the pair, not just pool and model existence", () => {
    const options = targets.map(({ pool, model }) => ({ pool, models: [model] }));
    expect(unavailablePricingTarget(targets, options)).toBeUndefined();
    const wrong = { pool: "first", model: "m2" };
    expect(unavailablePricingTarget([wrong], options)).toEqual(wrong);
  });
});

describe("pricing AI through the gateway", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.settings.mockResolvedValue({ priceSyncTargets: targets, priceSyncPool: "old", priceSyncModel: "legacy" });
    mocks.group.mockImplementation(async ({ where }) => ({ id: where.slug }));
    mocks.createKey.mockImplementation(async ({ data }) => ({ id: `run-${data.groupId}` }));
    mocks.deleteKeys.mockResolvedValue({ count: 1 });
  });
  it("uses the existing configured pair when no list has been saved", async () => {
    mocks.settings.mockResolvedValue({ priceSyncTargets: null, priceSyncPool: "old", priceSyncModel: "legacy" });
    mocks.gateway.mockResolvedValue(response("prices", "r1"));
    await expect(askPricingAi("sys", "page")).resolves.toMatchObject({ model: "legacy", requestIds: ["r1"] });
    expect(mocks.createKey).toHaveBeenCalledWith({ data: expect.objectContaining({ userId: "bot", groupId: "old" }) });
    expect(await mocks.gateway.mock.calls[0][0].json()).toMatchObject({ model: "legacy" });
  });
  it("tries pairs in order, stops on success and cleans up both metered keys", async () => {
    mocks.gateway.mockResolvedValueOnce(new Response("busy", { status: 503, headers: { "x-request-id": "r1" } })).mockResolvedValueOnce(response("prices", "r2"));
    await expect(askPricingAi("sys", "page")).resolves.toEqual({ text: "prices", model: "m2", requestId: "r2", requestIds: ["r1", "r2"] });
    expect(mocks.createKey.mock.calls.map(([arg]) => arg.data.groupId)).toEqual(["first", "second"]);
    const bodies = await Promise.all(mocks.gateway.mock.calls.map(([req]) => req.json()));
    expect(bodies.map((b) => b.model)).toEqual(["m1", "m2"]);
    expect(bodies[0].messages).toEqual(bodies[1].messages);
    expect(mocks.flush).toHaveBeenCalledTimes(2);
    for (const id of ["run-first", "run-second"]) expect(mocks.deleteKeys).toHaveBeenCalledWith({ where: { id } });
  });
  it("reports exhaustion and retains IDs from empty and malformed responses, even if another pool was removed", async () => {
    mocks.group.mockResolvedValueOnce(null);
    mocks.gateway.mockResolvedValueOnce(response("   ", "r2")).mockResolvedValueOnce(new Response("not json", { headers: { "x-request-id": "r3" } }));
    await expect(askPricingAi("sys", "page")).rejects.toMatchObject({ message: expect.stringMatching(/first \/ m1.*second \/ m2.*third \/ m3/), requestIds: ["r2", "r3"] });
    expect(mocks.flush).toHaveBeenCalledTimes(2);
  });
});
