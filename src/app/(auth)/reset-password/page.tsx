import Link from "next/link";
import type { Metadata } from "next";
import { XCircle } from "lucide-react";
import { AuthCard } from "@/components/auth/auth-card";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { isResetTokenValid } from "@/lib/auth/service";

export const metadata: Metadata = { title: "Reset password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const valid = token ? await isResetTokenValid(token) : false;
  return (
    <AuthCard
      title={valid ? "Choose a new password" : "Link expired"}
      description={valid ? "Pick a strong password you haven't used before." : undefined}
      footer={
        <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          Back to log in
        </Link>
      }
    >
      {valid && token ? (
        <ResetPasswordForm token={token} />
      ) : (
        <div className="space-y-3 text-center" role="alert">
          <XCircle className="mx-auto size-12 text-red-500" />
          <p className="text-sm text-muted-foreground">
            This password reset link is invalid or has expired.{" "}
            <Link href="/forgot-password" className="font-medium text-foreground underline-offset-4 hover:underline">
              Request a new one
            </Link>
            .
          </p>
        </div>
      )}
    </AuthCard>
  );
}
