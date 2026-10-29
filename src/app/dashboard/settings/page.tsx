import { PageHeader } from "@/components/common/page-header";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { SettingsClient } from "@/components/customer/settings-client";
import { getCurrentSessionId, listSessions, requireUser } from "@/lib/auth/session";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ require2fa?: string }> }) {
  const { user, session } = await requireUser();
  const require2fa = (await searchParams).require2fa === "1" && user.role !== "CUSTOMER" && !user.totpEnabled;
  const currentId = (await getCurrentSessionId()) ?? session.id;
  const sessions = await listSessions(user.id, currentId);
  return (
    <>
      <PageHeader title="Settings" description="Profile, security and sessions." />
      {require2fa && (
        <Alert className="mb-6" role="alert">
          <AlertDescription>Staff accounts must use two-factor authentication. Set it up below to open the admin console.</AlertDescription>
        </Alert>
      )}
      <SettingsClient
        user={{ name: user.name, email: user.email, emailVerified: !!user.emailVerifiedAt, totpEnabled: user.totpEnabled, balance: user.balance.toString(), notifyCc: user.notifyCc }}
        sessions={sessions.map((s) => ({ id: s.id, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt.toISOString(), current: s.current }))}
      />
    </>
  );
}
