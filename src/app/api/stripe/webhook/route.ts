import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getStripe, isStripeConfigured } from "@/server/billing/stripe";
import { handleStripeEvent } from "@/server/billing/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe webhook. Reads the RAW body for signature verification; answers 200 for every verified event
 * (including ones we ignore) and 500 only when processing failed, so Stripe retries (handlers are idempotent).
 */
export async function POST(req: Request) {
  if (!isStripeConfigured() || !env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Stripe webhooks are not configured" }, { status: 503 });
  }
  const signature = req.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing stripe-signature header" }, { status: 400 });

  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(raw, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn("stripe webhook signature verification failed", { err });
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  try {
    const result = await handleStripeEvent(event);
    logger.info("stripe webhook processed", { eventId: event.id, type: event.type, ...result });
    return NextResponse.json({ received: true, handled: result.handled });
  } catch (err) {
    logger.error("stripe webhook handler failed", { eventId: event.id, type: event.type, err });
    return NextResponse.json({ error: "Handler failed" }, { status: 500 });
  }
}

/** Stripe only POSTs; answer GET so a browser/health probe gets a clear message. */
export async function GET() {
  return NextResponse.json({ ok: true, configured: isStripeConfigured() && !!env.STRIPE_WEBHOOK_SECRET });
}
