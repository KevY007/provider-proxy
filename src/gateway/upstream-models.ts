// STUB created by lead — Backend (Phase 4) agent implements, keeping this signature.
// Lists the models a provider's first healthy key can see upstream (cached ~5 min), enriched with known prices.
import type { KnownPrice } from "./price-catalog";

export type UpstreamModel = {
  id: string;
  ownedBy?: string;
  shutdownDate?: string | null; // ISO date when the upstream announces retirement
  known?: KnownPrice | null;
  alreadyRouted?: boolean; // a ModelRoute for this provider + upstream model already exists
};

export async function listUpstreamModels(providerId: string): Promise<UpstreamModel[]> {
  void providerId;
  return [];
}
