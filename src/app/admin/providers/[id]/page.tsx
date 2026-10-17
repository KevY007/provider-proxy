import { ComingSoon } from "@/components/common/coming-soon";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ComingSoon title="Provider" description={`ID: ${id}`} />;
}
