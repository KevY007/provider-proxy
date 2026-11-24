import { beforeEach, expect, it, vi } from "vitest";
import { saveSettings } from "@/server/admin/settings-actions";

const mocks = vi.hoisted(() => ({ save: vi.fn(), pools: vi.fn(), authorize: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/auth/session", () => ({ requireAdminForAction: mocks.authorize }));
vi.mock("@/lib/settings", () => ({ getSettings: async () => ({ priceSyncTargets: null }), setSettings: mocks.save }));
vi.mock("@/server/admin/price-sync-queries", () => ({ getPricingPoolOptions: mocks.pools }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/gateway/cache", () => ({ invalidateGatewayConfig: vi.fn() }));
vi.mock("@/server/maintenance", () => ({ armTimers: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorize.mockResolvedValue({ user: { id: "admin" } });
  mocks.pools.mockResolvedValue([{ pool: "a", models: ["one"] }, { pool: "b", models: ["two"] }]);
});

it("requires admin authorization and persists valid pairs in submitted order", async () => {
  const targets = [{ pool: "b", model: "two" }, { pool: "a", model: "one" }];
  expect(await saveSettings({ priceSyncTargets: targets })).toMatchObject({ ok: true });
  expect(mocks.authorize).toHaveBeenCalledWith({ adminOnly: true });
  expect(mocks.save).toHaveBeenCalledWith({ priceSyncTargets: targets });
});

it.each([null, [], [{ pool: "a", model: "two" }], [{ pool: "missing", model: "one" }], [{ pool: "a", model: "one" }, { pool: "a", model: "one" }]].map((input) => ({ input })))("rejects invalid route data without writing: $input", async ({ input }) => {
  expect(await saveSettings({ priceSyncTargets: input })).toMatchObject({ ok: false, fieldErrors: { priceSyncTargets: expect.any(String) } });
  expect(mocks.save).not.toHaveBeenCalled();
});
