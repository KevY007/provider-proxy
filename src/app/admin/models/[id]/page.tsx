import { notFound } from "next/navigation";
import { ModelWorkspace } from "@/components/admin/models/model-workspace";
import { requireAdmin } from "@/lib/auth/session";
import { getModelDetail } from "@/server/admin/models-queries";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await getModelDetail(id).catch(() => null);
  return { title: d ? d.model.slug : "Model" };
}

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin({ adminOnly: true });
  const { id } = await params;
  const d = await getModelDetail(id);
  if (!d) notFound();
  return (
    <ModelWorkspace
      key={d.model.id}
      model={d.model}
      routes={d.routes}
      providers={d.providers}
      groups={d.groups}
      usage={d.totals ? { requests: d.totals.requests, revenue: d.totals.revenue, cost: d.totals.cost, profit: d.totals.profit, errorRate: d.totals.errorRate } : null}
    />
  );
}
