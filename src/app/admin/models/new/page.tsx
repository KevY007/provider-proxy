import { AddModelWizard } from "@/components/admin/models/add-model-wizard";
import { requireAdmin } from "@/lib/auth/session";
import { getTakenModelNames, getWizardProviders } from "@/server/admin/models-queries";

export const metadata = { title: "Add model" };
export const dynamic = "force-dynamic";

export default async function Page() {
  await requireAdmin({ adminOnly: true });
  const [providers, taken] = await Promise.all([getWizardProviders(), getTakenModelNames()]);
  return <AddModelWizard providers={providers} taken={taken} />;
}
