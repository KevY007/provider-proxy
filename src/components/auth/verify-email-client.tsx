"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { CheckCircle2, Loader2, MailCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { SubmitButton, TextField } from "@/components/common/form-fields";
import { resendVerificationAction, verifyEmailAction } from "@/lib/auth/actions";

/** Consumes ?token= on mount (client-side, so link scanners that don't run JS can't burn the token). */
export function VerifyToken({ token }: { token: string }) {
  const [state, setState] = useState<{ status: "loading" } | { status: "ok"; kind: string; email: string } | { status: "error"; error: string }>({
    status: "loading",
  });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    verifyEmailAction({ token }).then((res) => {
      if (res.ok && res.data) setState({ status: "ok", kind: res.data.kind, email: res.data.email });
      else setState({ status: "error", error: res.ok ? "Verification failed" : res.error });
    });
  }, [token]);

  if (state.status === "loading") {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-muted-foreground" role="status">
        <Loader2 className="size-8 animate-spin" />
        <p>Verifying your email...</p>
      </div>
    );
  }
  if (state.status === "ok") {
    return (
      <div className="flex flex-col items-center gap-4 py-4 text-center" role="status">
        <CheckCircle2 className="size-12 text-emerald-500" />
        <div>
          <p className="font-medium">{state.kind === "email_changed" ? "Email address updated" : "Email verified"}</p>
          <p className="text-sm text-muted-foreground">{state.email}</p>
        </div>
        <Button asChild className="w-full">
          <Link href="/login">Continue to log in</Link>
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-5 text-center" role="alert">
      <XCircle className="mx-auto size-12 text-red-500" />
      <p className="text-sm text-muted-foreground">{state.error}</p>
      <ResendForm />
    </div>
  );
}

/** "Check your inbox" state, shown after signup. */
export function CheckInbox({ email }: { email?: string }) {
  return (
    <div className="space-y-5 text-center">
      <MailCheck className="mx-auto size-12 text-primary" />
      <p className="text-sm text-muted-foreground">
        {email ? (
          <>
            We sent a verification link to <span className="font-medium text-foreground">{email}</span>. It expires in 24 hours.
          </>
        ) : (
          "We sent you a verification link. It expires in 24 hours."
        )}
      </p>
      <ResendForm defaultEmail={email} />
    </div>
  );
}

export function ResendForm({ defaultEmail }: { defaultEmail?: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    setError(undefined);
    start(async () => {
      const res = await resendVerificationAction({ email });
      if (res.ok) {
        toast.success(res.message ?? "Verification email sent");
        setCooldown(30);
      } else {
        setError(res.fieldErrors?.email ?? res.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-3 text-left" aria-label="Resend verification email">
      <FieldGroup>
        <TextField name="email" type="email" label="Email" defaultValue={defaultEmail} autoComplete="email" required error={error} />
      </FieldGroup>
      <SubmitButton pending={pending} disabled={cooldown > 0} variant="outline" className="w-full">
        {cooldown > 0 ? `Resend available in ${cooldown}s` : "Resend verification email"}
      </SubmitButton>
    </form>
  );
}
