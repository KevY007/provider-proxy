import type { MetadataRoute } from "next";
import { searchIndexingAllowed } from "@/lib/indexing";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

/**
 * Public pages may be indexed, the apps and the API never; SEARCH_INDEXING=off (lib/indexing.ts) or the
 * portal-only setting (no public site at all) hides everything.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const portalOnly = await getSetting("portalOnly").catch(() => false);
  if (!searchIndexingAllowed() || portalOnly) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/dashboard", "/api/", "/v1", "/v1beta", "/upload", "/login", "/signup"] }] };
}
