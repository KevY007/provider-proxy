import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { LoginForm } from "@/components/auth/login-form";
import { getSession } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/http";

export const metadata: Metadata = { title: "Log in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const session = await getSession();
  if (session) redirect(safeNextPath(next, session.user.role === "CUSTOMER" ? "/dashboard" : "/admin"));
  return (
    <AuthCard
      title="Welcome back"
      description="Log in to manage your API keys and usage."
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link href="/signup" className="font-medium text-foreground underline-offset-4 hover:underline">
            Sign up
          </Link>
        </>
      }
    >
      <LoginForm next={next ? safeNextPath(next, "") || undefined : undefined} />
    </AuthCard>
  );
}
