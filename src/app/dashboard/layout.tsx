import { AppShell } from "@/components/shell/app-shell";
import { getShellData } from "@/components/shell/shell-data";
import { requireUser } from "@/lib/auth/session";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, impersonatorId } = await requireUser();
  const shell = await getShellData();
  return (
    <AppShell
      variant="customer"
      user={{ name: user.name, email: user.email, role: user.role }}
      balance={user.balance.toString()}
      customerBilling={shell.customerBilling}
      siteName={shell.siteName}
      announcements={shell.announcements}
      defaultOpen={shell.defaultOpen}
      impersonating={impersonatorId ? user.email : null}
    >
      {children}
    </AppShell>
  );
}
