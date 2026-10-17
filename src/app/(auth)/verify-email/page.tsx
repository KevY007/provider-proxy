import Link from "next/link";
import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { CheckInbox, VerifyToken } from "@/components/auth/verify-email-client";

export const metadata: Metadata = { title: "Verify your email" };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ token?: string; email?: string }> }) {
  const { token, email } = await searchParams;
  return (
    <AuthCard
      title={token ? "Email verification" : "Check your inbox"}
      description={token ? undefined : "One more step to activate your account."}
      footer={
        <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          Back to log in
        </Link>
      }
    >
      {token ? <VerifyToken token={token} /> : <CheckInbox email={email} />}
    </AuthCard>
  );
}
