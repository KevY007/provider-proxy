import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { PageHeader } from "@/components/common/page-header";
import { StatusBadge } from "@/components/common/status-badge";
import { ProviderEditor } from "@/components/admin/providers/provider-editor";
import { ProviderKeys } from "@/components/admin/providers/provider-keys";
import { ProviderSidePanels } from "@/components/admin/providers/provider-side-panels";
import { getPreset } from "@/gateway/providers/presets";
import { requireAdmin } from "@/lib/auth/session";
import { getProviderDetail } from "@/server/admin/providers-queries";

export const metadata = { title: "Provider" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireAdmin();
  const { id } = await params;
  const detail = await getProviderDetail(id);
  if (!detail) notFound();
  const { provider } = detail;
  const canEdit = user.role === "ADMIN";
  return (
    <>
      <Link href="/admin/providers" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ChevronLeft className="size-4" /> Providers
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {provider.name}
            <StatusBadge status={provider.status} />
            <StatusBadge status={provider.healthStatus} />
          </span>
        }
        description={<span className="font-mono text-xs">{provider.baseUrl}</span>}
      />
      <div className="space-y-6">
        <ProviderKeys providerId={provider.id} keys={detail.keys} initialSlots={detail.slots} providerMaxConcurrency={provider.maxConcurrency} canEdit={canEdit} />
        <ProviderEditor provider={provider} canEdit={canEdit} routeCount={detail.routes.length} keyCount={detail.keys.length} presetFormats={provider.preset === "custom" ? null : (getPreset(provider.preset)?.formats.slice() ?? null)} />
        <ProviderSidePanels checks={detail.checks} routes={detail.routes} />
      </div>
    </>
  );
}
