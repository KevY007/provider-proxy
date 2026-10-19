import { getPublicPricing } from "@/gateway/public-pricing";
import { logger } from "@/lib/logger";
import { publicVisibility } from "@/server/customer/visibility";

/**
 * Public price list, no authentication: official vs customer price per unit for every servable ACTIVE model,
 * `?group=<slug>` for a public group. Cacheable for 60s, CORS `*`. No costs, providers or upstream model ids.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS", "access-control-allow-headers": "content-type" };

export async function GET(req: Request): Promise<Response> {
  try {
    const vis = await publicVisibility();
    // private pricing (served only to a signed-in visitor) must never land in a shared cache
    const cache = vis.pricingIsPublic ? "public, max-age=60" : "private, no-store";
    if (!vis.pricing) {
      return Response.json(
        { error: { message: "Pricing is only available to signed-in customers.", type: "authentication_error", code: "pricing_private", param: null } },
        { status: 401, headers: { ...CORS, "cache-control": "no-store" } },
      );
    }
    const group = new URL(req.url).searchParams.get("group")?.trim().toLowerCase().slice(0, 64) || null;
    const body = await getPublicPricing(group);
    if (!body) {
      return Response.json({ error: { message: `Unknown group '${group}'.`, type: "invalid_request_error", code: "group_not_found", param: "group" } }, { status: 404, headers: { ...CORS, "cache-control": cache } });
    }
    return Response.json(body, { headers: { ...CORS, "cache-control": vis.pricingIsPublic ? "public, max-age=60, s-maxage=60, stale-while-revalidate=120" : cache } });
  } catch (err) {
    logger.error("public pricing failed", { err });
    return Response.json({ error: { message: "Pricing is temporarily unavailable.", type: "server_error", code: "internal_error", param: null } }, { status: 503, headers: { ...CORS, "cache-control": "no-store" } });
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });
}
