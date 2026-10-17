import "server-only";
import { db } from "@/lib/db";
import { deriveOnboarding, type OnboardingState } from "./onboarding";

/** Reads the DB state that drives the onboarding checklist and derives the steps. */
export async function getOnboarding(user: { id: string; balance: { toString(): string }; emailVerifiedAt: Date | null }): Promise<OnboardingState> {
  const [funded, keyCount, request] = await Promise.all([
    db.ledgerEntry.findFirst({ where: { userId: user.id, amount: { gt: 0 }, type: { in: ["TOPUP", "AUTO_RECHARGE", "REDEEM", "ADJUSTMENT"] } }, select: { id: true } }),
    db.apiKey.count({ where: { userId: user.id, isPlayground: false, status: { not: "REVOKED" } } }),
    db.requestLog.findFirst({ where: { userId: user.id, status: "SUCCESS" }, select: { id: true } }),
  ]);
  return deriveOnboarding({
    emailVerified: !!user.emailVerifiedAt,
    balance: user.balance.toString(),
    everFunded: !!funded,
    keyCount,
    requestCount: request ? 1 : 0,
  });
}
