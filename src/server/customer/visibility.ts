import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";

/**
 * What a visitor may see on the public site: everything when signed in, otherwise what the admin made public.
 * With `portalOnly` on, a visitor who is not signed in sees nothing at all.
 */
export async function publicVisibility(): Promise<{ signedIn: boolean; portalOnly: boolean; models: boolean; pricing: boolean; status: boolean; pricingIsPublic: boolean }> {
  const [s, session] = await Promise.all([getSettings(), getSession().catch(() => null)]);
  const signedIn = !!session;
  const open = !s.portalOnly;
  // the price list names every model, so it is public only while the model list is too
  const pricingIsPublic = open && s.publicPricing && s.publicModels;
  return {
    signedIn,
    portalOnly: s.portalOnly,
    models: (open && s.publicModels) || signedIn,
    pricing: pricingIsPublic || signedIn,
    status: (open && s.publicStatus) || signedIn,
    pricingIsPublic,
  };
}

/** Public-site pages call this first: in portal-only mode a visitor who is not signed in is sent to log in. */
export async function requirePublicSite(path: string): Promise<Awaited<ReturnType<typeof publicVisibility>>> {
  const vis = await publicVisibility();
  if (vis.portalOnly && !vis.signedIn) redirect(`/login?next=${encodeURIComponent(path)}`);
  return vis;
}
