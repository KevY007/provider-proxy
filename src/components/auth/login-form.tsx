"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { PasswordField, SubmitButton, TextField } from "@/components/common/form-fields";
import { loginAction, resendVerificationAction } from "@/lib/auth/actions";
import { loginSchema, fieldErrorsFrom } from "@/lib/auth/schemas";

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const input = { email: String(fd.get("email") ?? ""), password: String(fd.get("password") ?? ""), next };
    const parsed = loginSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setErrors({});
    setFormError(null);
    setUnverified(null);
    start(async () => {
      const res = await loginAction(input);
      if (res.ok) {
        router.replace(res.data?.redirectTo ?? "/dashboard");
        router.refresh();
        return;
      }
      if (res.fieldErrors?._unverified !== undefined) setUnverified(res.fieldErrors._unverified || input.email);
      setErrors(res.fieldErrors ?? {});
      setFormError(res.error);
    });
  }

  async function resend() {
    if (!unverified) return;
    const res = await resendVerificationAction({ email: unverified });
    if (res.ok) toast.success(res.message ?? "Verification email sent");
    else toast.error(res.error);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5" aria-label="Log in">
      {formError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {formError}
            {unverified && (
              <Button type="button" variant="link" className="h-auto p-0 pl-1" onClick={resend}>
                Resend verification email
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      <FieldGroup>
        <TextField name="email" type="email" label="Email" autoComplete="email" placeholder="you@company.com" autoFocus required error={errors.email} />
        <PasswordField
          name="password"
          label="Password"
          autoComplete="current-password"
          required
          error={errors.password}
          labelAction={
            <Link href="/forgot-password" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
              Forgot password?
            </Link>
          }
        />
      </FieldGroup>
      <SubmitButton pending={pending} className="w-full">
        Log in
      </SubmitButton>
    </form>
  );
}
