import { GroupsView } from "@/components/admin/groups/groups-view";
import { requireAdmin } from "@/lib/auth/session";
import { getGroupFormOptions, getGroupRows } from "@/server/admin/groups-queries";

export const metadata = { title: "Groups" };
export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin({ adminOnly: true });
  const [rows, options] = await Promise.all([getGroupRows(), getGroupFormOptions()]);
  return <GroupsView rows={rows} options={options} />;
}
