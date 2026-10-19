import { AppShell } from "@/components/shell/app-shell";
import { getShellData } from "@/components/shell/shell-data";
import { requireAdmin } from "@/lib/auth/session";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // ADMIN or SUPPORT. Pages that are admin-only call requireAdmin({ adminOnly: true }) themselves.
  const { user } = await requireAdmin();
  const shell = await getShellData();
  return (
    <AppShell
      variant="admin"
      user={{ name: user.name, email: user.email, role: user.role }}
      siteName={shell.siteName}
      announcements={shell.announcements}
      defaultOpen={shell.defaultOpen}
    >
      {children}
    </AppShell>
  );
}
