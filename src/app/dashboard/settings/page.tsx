import { PageHeader } from "@/components/common/page-header";
import { SettingsClient } from "@/components/customer/settings-client";
import { getCurrentSessionId, listSessions, requireUser } from "@/lib/auth/session";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user, session } = await requireUser();
  const currentId = (await getCurrentSessionId()) ?? session.id;
  const sessions = await listSessions(user.id, currentId);
  return (
    <>
      <PageHeader title="Settings" description="Profile, security and sessions." />
      <SettingsClient
        user={{ name: user.name, email: user.email, emailVerified: !!user.emailVerifiedAt, totpEnabled: user.totpEnabled, balance: user.balance.toString() }}
        sessions={sessions.map((s) => ({ id: s.id, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt.toISOString(), current: s.current }))}
      />
    </>
  );
}
