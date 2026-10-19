import { ModelsView } from "@/components/admin/models/models-view";
import { requireAdmin } from "@/lib/auth/session";
import { getModelRows } from "@/server/admin/models-queries";

export const metadata = { title: "Models" };
export const dynamic = "force-dynamic";

export default async function Page() {
  // exposes route cost prices -> ADMIN only
  await requireAdmin({ adminOnly: true });
  const rows = await getModelRows();
  const vendors = [...new Set(rows.map((r) => r.vendor))].sort();
  return <ModelsView rows={rows} vendors={vendors} />;
}
