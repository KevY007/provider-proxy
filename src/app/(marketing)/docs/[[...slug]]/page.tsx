import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { DocsSidebar } from "@/components/marketing/docs/docs-sidebar";
import { renderDoc, type DocCtx } from "@/components/marketing/docs/content";
import { docHref, findDocPage, prevNext } from "@/components/marketing/docs/registry";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { appUrl } from "@/lib/env";
import { getSetting } from "@/lib/settings";
import { getCatalogModels } from "@/server/customer/catalog";
import { publicVisibility, requirePublicSite } from "@/server/customer/visibility";
import { List } from "lucide-react";

export const dynamic = "force-dynamic";

type Params = { slug?: string[] };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const page = findDocPage((slug ?? []).join("/"));
  if (!page) return { title: "Docs" };
  return { title: `${page.title} - Docs`, description: page.description };
}

async function buildCtx(): Promise<DocCtx> {
  const [siteName, vis, customerBilling] = await Promise.all([getSetting("siteName"), publicVisibility(), getSetting("customerBilling")]);
  // examples use real model ids only when the model list is visible to this visitor (generic ids otherwise)
  const models = vis.models ? await getCatalogModels().catch(() => []) : [];
  const pick = (pred: (m: (typeof models)[number]) => boolean, fallback: string) => models.find(pred)?.slug ?? fallback;
  return {
    appUrl,
    base: `${appUrl}/v1`,
    siteName,
    customerBilling,
    m: {
      chat: pick((m) => m.capabilities.includes("chat") && m.vendor === "openai", pick((m) => m.capabilities.includes("chat"), "gpt-6-sol")),
      claude: pick((m) => m.vendor === "anthropic" && m.capabilities.includes("chat"), "claude-sonnet-5-5"),
      gemini: pick((m) => m.vendor === "google" && m.capabilities.includes("chat"), "gemini-3.1-pro"),
      image: pick((m) => m.capabilities.includes("images"), "gpt-image-2"),
      embed: pick((m) => m.capabilities.includes("embeddings"), "text-embedding-3-small"),
    },
  };
}

export default async function DocsPage({ params }: { params: Promise<Params> }) {
  const { slug: parts } = await params;
  const slug = (parts ?? []).join("/");
  await requirePublicSite(slug ? `/docs/${slug}` : "/docs");
  const page = findDocPage(slug);
  if (!page) notFound();
  const ctx = await buildCtx();
  const body = renderDoc(slug, ctx);
  if (!body) notFound();
  const { prev, next } = prevNext(slug);

  return (
    <div className="mx-auto w-full max-w-6xl gap-10 px-4 py-8 lg:grid lg:grid-cols-[14rem_minmax(0,1fr)]">
      <aside className="hidden lg:block">
        <div className="sticky top-20 max-h-[calc(100vh-6rem)] overflow-y-auto pb-8 pr-2">
          <DocsSidebar />
        </div>
      </aside>
      <div className="min-w-0">
        <div className="mb-4 lg:hidden">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="outline" size="sm">
                <List className="size-4" /> Docs menu
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 overflow-y-auto">
              <SheetHeader>
                <SheetTitle>Documentation</SheetTitle>
              </SheetHeader>
              <div className="px-4 pb-6">
                <DocsSidebar />
              </div>
            </SheetContent>
          </Sheet>
        </div>
        <article className="max-w-3xl">
          <header className="mb-6 space-y-2">
            <h1 className="text-3xl font-semibold tracking-tight">{page.title}</h1>
            <p className="text-muted-foreground">{page.description}</p>
          </header>
          {body}
          <nav className="mt-14 grid gap-3 border-t pt-6 sm:grid-cols-2" aria-label="Pagination">
            {prev ? (
              <Link href={docHref(prev.slug)} className="group rounded-lg border p-4 transition hover:border-primary/40">
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <ArrowLeft className="size-3" /> Previous
                </span>
                <span className="font-medium group-hover:text-primary">{prev.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link href={docHref(next.slug)} className="group rounded-lg border p-4 text-right transition hover:border-primary/40 sm:col-start-2">
                <span className="flex items-center justify-end gap-1 text-xs text-muted-foreground">
                  Next <ArrowRight className="size-3" />
                </span>
                <span className="font-medium group-hover:text-primary">{next.title}</span>
              </Link>
            )}
          </nav>
        </article>
      </div>
    </div>
  );
}
