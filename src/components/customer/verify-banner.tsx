"use client";

import { useState, useTransition } from "react";
import { MailWarning } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { resendVerificationAction } from "@/lib/auth/actions";

/** Shown when the customer's email is not verified yet (blocks key creation). */
export function VerifyBanner({ email }: { email: string }) {
  const [pending, start] = useTransition();
  const [sent, setSent] = useState(false);
  return (
    <Alert className="mb-6 border-amber-500/40 bg-amber-500/5">
      <MailWarning className="text-amber-500" />
      <AlertTitle>Verify your email to create API keys</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>
          We sent a verification link to <span className="font-medium text-foreground">{email}</span>.
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || sent}
          onClick={() =>
            start(async () => {
              const r = await resendVerificationAction({ email });
              if (r.ok) {
                setSent(true);
                toast.success(r.message ?? "Verification email sent");
              } else toast.error(r.error);
            })
          }
        >
          {sent ? "Email sent" : "Resend email"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
