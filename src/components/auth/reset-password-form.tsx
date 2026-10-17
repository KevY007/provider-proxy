"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FieldGroup } from "@/components/ui/field";
import { PasswordField, SubmitButton } from "@/components/common/form-fields";
import { resetPasswordAction } from "@/lib/auth/actions";
import { fieldErrorsFrom, resetPasswordSchema } from "@/lib/auth/schemas";

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const input = {
      token,
      password: String(fd.get("password") ?? ""),
      confirmPassword: String(fd.get("confirmPassword") ?? ""),
    };
    const parsed = resetPasswordSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setErrors({});
    setFormError(null);
    start(async () => {
      const res = await resetPasswordAction(input);
      if (res.ok) {
        toast.success(res.message ?? "Password updated");
        router.replace("/login");
      } else {
        setErrors(res.fieldErrors ?? {});
        setFormError(res.error);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5" aria-label="Choose a new password">
      {formError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <FieldGroup>
        <PasswordField name="password" label="New password" autoComplete="new-password" autoFocus required description="At least 8 characters." error={errors.password} />
        <PasswordField name="confirmPassword" label="Confirm new password" autoComplete="new-password" required error={errors.confirmPassword} />
      </FieldGroup>
      <SubmitButton pending={pending} className="w-full">
        Update password
      </SubmitButton>
    </form>
  );
}
