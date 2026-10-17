"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FieldGroup } from "@/components/ui/field";
import { SubmitButton, TextField } from "@/components/common/form-fields";
import { verifyTwoFactorAction } from "@/lib/auth/actions";
import { totpCodeSchema } from "@/lib/auth/schemas";

export function TwoFactorForm({ next }: { next?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").replace(/\s/g, "");
    const parsed = totpCodeSchema.safeParse(code);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setError(undefined);
    setFormError(null);
    start(async () => {
      const res = await verifyTwoFactorAction({ code, next });
      if (res.ok && res.data) {
        router.replace(res.data.redirectTo);
        router.refresh();
      } else if (!res.ok) {
        setError(res.fieldErrors?.code);
        setFormError(res.fieldErrors?.code ? null : res.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5" aria-label="Two-factor authentication">
      {formError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <FieldGroup>
        <TextField
          name="code"
          label="Authentication code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={7}
          placeholder="123456"
          autoFocus
          required
          className="text-center text-lg tracking-[0.4em]"
          error={error}
        />
      </FieldGroup>
      <SubmitButton pending={pending} className="w-full">
        Verify
      </SubmitButton>
    </form>
  );
}
