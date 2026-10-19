/** Search indexing switch: public pages indexable by default; SEARCH_INDEXING=off hides everything. */
import { afterEach, describe, expect, it } from "vitest";
import robots from "@/app/robots";

describe("robots.txt", () => {
  afterEach(() => {
    delete process.env.SEARCH_INDEXING;
  });
  it("default: public pages allowed, apps and API disallowed", () => {
    const r = robots().rules as Array<{ allow?: string; disallow?: string[] }>;
    expect(r[0].allow).toBe("/");
    expect(r[0].disallow).toEqual(expect.arrayContaining(["/admin", "/dashboard", "/v1"]));
  });
  it("SEARCH_INDEXING=off: everything disallowed", () => {
    process.env.SEARCH_INDEXING = "off";
    expect(robots().rules).toEqual([{ userAgent: "*", disallow: "/" }]);
  });
});
