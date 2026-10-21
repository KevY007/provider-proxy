/** Portal-only mode: a visitor who is not signed in sees none of the public site; signed-in users see all of it. */
import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: { portalOnly: false, publicPricing: true, publicModels: true, publicStatus: true },
  session: null as null | { user: { role: string } },
}));
vi.mock("@/lib/settings", () => ({ getSettings: async () => state.settings }));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => state.session }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

import { publicVisibility, requirePublicSite } from "@/server/customer/visibility";

afterEach(() => {
  state.settings = { portalOnly: false, publicPricing: true, publicModels: true, publicStatus: true };
  state.session = null;
});

describe("portal-only", () => {
  it("off (default): the public switches decide", async () => {
    const v = await publicVisibility();
    expect(v).toMatchObject({ portalOnly: false, models: true, pricing: true, status: true, pricingIsPublic: true });
    await expect(requirePublicSite("/docs")).resolves.toBeTruthy();
  });

  it("on: a visitor who is not signed in is sent to log in, and nothing is public", async () => {
    state.settings.portalOnly = true;
    const v = await publicVisibility();
    expect(v).toMatchObject({ signedIn: false, models: false, pricing: false, status: false, pricingIsPublic: false });
    for (const p of ["/docs", "/docs/errors", "/pricing", "/status"]) {
      await expect(requirePublicSite(p)).rejects.toThrow(`REDIRECT /login?next=${encodeURIComponent(p)}`);
    }
  });

  it("on: signed-in users still see docs, pricing and status (never cached as public)", async () => {
    state.settings.portalOnly = true;
    state.session = { user: { role: "CUSTOMER" } };
    const v = await requirePublicSite("/pricing");
    expect(v).toMatchObject({ signedIn: true, models: true, pricing: true, status: true, pricingIsPublic: false });
  });
});
