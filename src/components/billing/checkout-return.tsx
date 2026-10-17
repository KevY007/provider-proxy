"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { syncCheckoutAction, syncSetupIntentAction } from "@/server/billing/actions";

/**
 * Handles the query params Stripe redirects back with (Checkout success/cancel, redirect-based card setup),
 * settles server-side without waiting for the webhook, shows a toast and cleans the URL.
 */
export function CheckoutReturn({ topup, sessionId, setupIntent }: { topup?: string; sessionId?: string; setupIntent?: string }) {
  const router = useRouter();
  const done = useRef(false);

  useEffect(() => {
    if (done.current || (!topup && !setupIntent)) return;
    done.current = true;
    (async () => {
      if (topup === "cancelled") {
        toast.message("Checkout cancelled - you weren't charged.");
      } else if (topup === "success" && sessionId) {
        const res = await syncCheckoutAction({ sessionId });
        if (res.ok && res.data?.status === "succeeded") toast.success("Payment received - your balance has been updated");
        else if (res.ok) toast.message("Payment is processing - your balance will update shortly.");
        else toast.error(res.error);
      } else if (setupIntent) {
        const res = await syncSetupIntentAction({ setupIntentId: setupIntent });
        if (res.ok) toast.success("Card saved");
        else toast.error(res.error);
      }
      router.replace("/dashboard/billing");
      router.refresh();
    })();
  }, [topup, sessionId, setupIntent, router]);

  return null;
}
