import { checkApiKey, extractApiKey } from "@/gateway/auth";
import { getConfig, type AuthRecord } from "@/gateway/cache";
import { errorBody, errorHeaders, isGatewayError } from "@/gateway/errors";
import { getPublicPricing } from "@/gateway/public-pricing";
import { getClientIp } from "@/lib/http";
import { logger } from "@/lib/logger";
import { publicVisibility } from "@/server/customer/visibility";

/**
 * Price list: official vs customer price per unit for every servable ACTIVE model, `?group=<slug>` for a public
 * group. No costs, providers or upstream model ids. CORS `*`.
 *  - Public pricing on: open to everyone, cacheable for 60s.
 *  - Public pricing off (or portal-only): a signed-in visitor, or any request carrying a valid API key (the same
 *    headers as the API: `Authorization: Bearer`, `x-api-key`, `x-goog-api-key`, `?key=`), so price fetchers keep
 *    working. Everyone else gets 401.
 *  - With a key and no `?group=`, the prices are the key's own (its group, customer multiplier and model allow-list).
 *    A key that is present but invalid is always rejected, so a fetcher notices a revoked key.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-api-key, x-goog-api-key",
};
const NO_STORE = { ...CORS, "cache-control": "no-store" };

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const raw = extractApiKey(req.headers, url);
    let viewer: AuthRecord | null = null;
    if (raw) {
      try {
        viewer = await checkApiKey(raw, getClientIp(req.headers), await getConfig());
      } catch (err) {
        if (!isGatewayError(err)) throw err;
        return Response.json(errorBody("openai", err), { status: err.status, headers: { ...errorHeaders(err), ...NO_STORE } });
      }
    }
    const vis = await publicVisibility();
    if (!vis.pricing && !viewer) {
      return Response.json(
        {
          error: {
            message: "Pricing is only available to signed-in customers or with an API key (Authorization: Bearer <key>).",
            type: "authentication_error",
            code: "pricing_private",
            param: null,
          },
        },
        { status: 401, headers: NO_STORE },
      );
    }
    // anything shown only because of a key or a session must never land in a shared cache
    const shared = vis.pricingIsPublic && !viewer;
    const cache = shared ? "public, max-age=60, s-maxage=60, stale-while-revalidate=120" : "private, no-store";
    const group = url.searchParams.get("group")?.trim().toLowerCase().slice(0, 64) || null;
    const body = await getPublicPricing(group, viewer);
    if (!body) {
      return Response.json(
        { error: { message: `Unknown group '${group}'.`, type: "invalid_request_error", code: "group_not_found", param: "group" } },
        { status: 404, headers: { ...CORS, "cache-control": shared ? "public, max-age=60" : "private, no-store" } },
      );
    }
    return Response.json(body, { headers: { ...CORS, "cache-control": cache } });
  } catch (err) {
    logger.error("public pricing failed", { err });
    return Response.json({ error: { message: "Pricing is temporarily unavailable.", type: "server_error", code: "internal_error", param: null } }, { status: 503, headers: NO_STORE });
  }
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });
}
