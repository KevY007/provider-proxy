/** Search indexing switch: public pages indexable by default; SEARCH_INDEXING=off or portal-only hides everything. */
import { afterEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => ({ portalOnly: false }));
vi.mock("@/lib/settings", () => ({ getSetting: async (k: "portalOnly") => settings[k] }));

import robots from "@/app/robots";

describe("robots.txt", () => {
  afterEach(() => {
    delete process.env.SEARCH_INDEXING;
    settings.portalOnly = false;
  });
  it("default: public pages allowed, apps and API disallowed", async () => {
    const r = (await robots()).rules as Array<{ allow?: string; disallow?: string[] }>;
    expect(r[0].allow).toBe("/");
    expect(r[0].disallow).toEqual(expect.arrayContaining(["/admin", "/dashboard", "/v1"]));
  });
  it("SEARCH_INDEXING=off: everything disallowed", async () => {
    process.env.SEARCH_INDEXING = "off";
    expect((await robots()).rules).toEqual([{ userAgent: "*", disallow: "/" }]);
  });
  it("portal-only: everything disallowed", async () => {
    settings.portalOnly = true;
    expect((await robots()).rules).toEqual([{ userAgent: "*", disallow: "/" }]);
  });
});
