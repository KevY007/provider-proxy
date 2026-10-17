"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FieldGroup } from "@/components/ui/field";
import { PasswordField, SubmitButton, TextField } from "@/components/common/form-fields";
import { signupAction } from "@/lib/auth/actions";
import { fieldErrorsFrom, signupSchema } from "@/lib/auth/schemas";

export function SignupForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const input = {
      name: String(fd.get("name") ?? "") || undefined,
      email: String(fd.get("email") ?? ""),
      password: String(fd.get("password") ?? ""),
    };
    const parsed = signupSchema.safeParse(input);
    if (!parsed.success) {
      setErrors(fieldErrorsFrom(parsed.error));
      return;
    }
    setErrors({});
    setFormError(null);
    start(async () => {
      const res = await signupAction(input);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        setFormError(res.error);
        return;
      }
      if (res.data?.verificationRequired === false) {
        toast.success("Welcome aboard!");
        router.replace("/dashboard");
        router.refresh();
      } else {
        router.push(`/verify-email?email=${encodeURIComponent(parsed.data.email)}`);
      }
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5" aria-label="Create account">
      {formError && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      )}
      <FieldGroup>
        <TextField name="name" label="Name (optional)" autoComplete="name" placeholder="Ada Lovelace" error={errors.name} />
        <TextField name="email" type="email" label="Email" autoComplete="email" placeholder="you@company.com" required error={errors.email} />
        <PasswordField
          name="password"
          label="Password"
          autoComplete="new-password"
          required
          description="At least 8 characters."
          error={errors.password}
        />
      </FieldGroup>
      <SubmitButton pending={pending} className="w-full">
        Create account
      </SubmitButton>
      <p className="text-center text-xs text-muted-foreground">
        By creating an account you agree to use the service responsibly and in line with upstream provider policies.
      </p>
    </form>
  );
}
