"use client";

import { useState, useTransition } from "react";
import { MailCheck } from "lucide-react";
import { FieldGroup } from "@/components/ui/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SubmitButton, TextField } from "@/components/common/form-fields";
import { forgotPasswordAction } from "@/lib/auth/actions";
import { fieldErrorsFrom, forgotPasswordSchema } from "@/lib/auth/schemas";

export function ForgotPasswordForm() {
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const input = { email: String(new FormData(e.currentTarget).get("email") ?? "") };
    const parsed = forgotPasswordSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setErrors({});
    setFormError(null);
    start(async () => {
      const res = await forgotPasswordAction(input);
      if (res.ok) setSent(res.message ?? "Check your inbox.");
      else {
        setErrors(res.fieldErrors ?? {});
        setFormError(res.error);
      }
    });
  }

  if (sent) {
    return (
      <div className="space-y-3 py-2 text-center" role="status">
        <MailCheck className="mx-auto size-12 text-primary" />
        <p className="text-sm text-muted-foreground">{sent}</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5" aria-label="Request password reset">
      {formError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <FieldGroup>
        <TextField name="email" type="email" label="Email" autoComplete="email" placeholder="you@company.com" autoFocus required error={errors.email} />
      </FieldGroup>
      <SubmitButton pending={pending} className="w-full">
        Send reset link
      </SubmitButton>
    </form>
  );
}
