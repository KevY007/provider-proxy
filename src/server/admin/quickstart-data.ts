import "server-only";
import { db } from "@/lib/db";
import { deriveQuickStart, type QuickStartState } from "./quickstart";

/** Reads the DB state that drives the admin Quick start checklist. */
export async function getQuickStart(): Promise<QuickStartState> {
  const priced = {
    OR: [
      { inputPrice: { gt: 0 } },
      { outputPrice: { gt: 0 } },
      { imagePrice: { gt: 0 } },
      { perSecondPrice: { gt: 0 } },
      { perMinutePrice: { gt: 0 } },
      { perMillionChars: { gt: 0 } },
      { requestPrice: { gt: 0 } },
    ],
  };
  const live = { status: "ACTIVE" as const, routes: { some: { enabled: true, provider: { status: "ACTIVE" as const } } } };
  const [activeKeys, testedProviders, liveModels, pricedModels, customerRequest] = await Promise.all([
    db.providerKey.count({ where: { status: "ACTIVE", provider: { status: "ACTIVE" } } }),
    db.healthCheck.groupBy({ by: ["providerId"] }).then((g) => g.length),
    db.model.count({ where: live }),
    db.model.count({ where: { ...live, ...priced } }),
    db.requestLog.findFirst({ where: { status: "SUCCESS", user: { role: "CUSTOMER" } }, select: { id: true } }),
  ]);
  return deriveQuickStart({ activeKeys, testedProviders, liveModels, pricedModels, customerRequests: customerRequest ? 1 : 0 });
}
