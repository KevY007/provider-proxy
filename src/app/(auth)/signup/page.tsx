import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { SignupForm } from "@/components/auth/signup-form";
import { getSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";

export const metadata: Metadata = { title: "Sign up" };

export default async function SignupPage() {
  const session = await getSession();
  if (session) redirect(session.user.role === "CUSTOMER" ? "/dashboard" : "/admin");
  const [enabled, users] = await Promise.all([getSetting("signupEnabled"), db.user.count()]);
  const closed = !enabled && users > 0;
  return (
    <AuthCard
      title={closed ? "Signups are closed" : "Create your account"}
      description={closed ? "New registrations are currently disabled." : "Get an API key in under a minute."}
      footer={
        <>
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
            Log in
          </Link>
        </>
      }
    >
      {closed ? null : <SignupForm />}
    </AuthCard>
  );
}
