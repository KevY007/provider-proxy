import { Construction } from "lucide-react";
import { EmptyState } from "./empty-state";
import { PageHeader } from "./page-header";

/** Placeholder body for pages that other agents will replace. */
export function ComingSoon({ title, description }: { title: string; description?: string }) {
  return (
    <>
      <PageHeader title={title} description={description} />
      <EmptyState icon={Construction} title="Coming soon" description="This page is under construction." />
    </>
  );
}
