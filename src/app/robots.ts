import type { MetadataRoute } from "next";
import { searchIndexingAllowed } from "@/lib/indexing";

export const dynamic = "force-dynamic";

/** Public pages may be indexed, the apps and the API never; SEARCH_INDEXING=off hides everything (lib/indexing.ts). */
export default function robots(): MetadataRoute.Robots {
  if (!searchIndexingAllowed()) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/admin", "/dashboard", "/api/", "/v1", "/v1beta", "/upload", "/login", "/signup"] }] };
}
