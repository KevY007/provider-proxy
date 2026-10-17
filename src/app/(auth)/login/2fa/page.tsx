import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { TwoFactorForm } from "@/components/auth/two-factor-form";
import { getPendingTwoFactorSession } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/http";

export const metadata: Metadata = { title: "Two-factor authentication" };

export default async function TwoFactorPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const pending = await getPendingTwoFactorSession();
  if (!pending) redirect("/login");
  return (
    <AuthCard title="Two-factor authentication" description="Enter the 6-digit code from your authenticator app.">
      <TwoFactorForm next={next ? safeNextPath(next, "") || undefined : undefined} />
    </AuthCard>
  );
}
