import { getSession } from "@/lib/auth/session";
import { getSettings } from "@/lib/settings";

/** What a visitor may see on the public site: everything when signed in, otherwise what the admin made public. */
export async function publicVisibility(): Promise<{ signedIn: boolean; models: boolean; pricing: boolean; status: boolean; pricingIsPublic: boolean }> {
  const [s, session] = await Promise.all([getSettings(), getSession().catch(() => null)]);
  const signedIn = !!session;
  // the price list names every model, so it is public only while the model list is too
  const pricingIsPublic = s.publicPricing && s.publicModels;
  return { signedIn, models: s.publicModels || signedIn, pricing: pricingIsPublic || signedIn, status: s.publicStatus || signedIn, pricingIsPublic };
}
