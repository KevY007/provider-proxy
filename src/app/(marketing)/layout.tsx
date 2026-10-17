import Link from "next/link";
import { Zap } from "lucide-react";
import { SiteHeader } from "@/components/marketing/site-header";
import { getSession } from "@/lib/auth/session";
import { getSetting } from "@/lib/settings";

export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  const [siteName, supportEmail, session] = await Promise.all([
    getSetting("siteName"),
    getSetting("supportEmail"),
    getSession().catch(() => null),
  ]);
  const cols: Array<{ title: string; links: Array<{ href: string; label: string }> }> = [
    {
      title: "Product",
      links: [
        { href: "/pricing", label: "Pricing" },
        { href: "/status", label: "Status" },
        { href: "/signup", label: "Get started" },
      ],
    },
    {
      title: "Developers",
      links: [
        { href: "/docs", label: "Quickstart" },
        { href: "/docs/openai/chat-completions", label: "OpenAI API" },
        { href: "/docs/anthropic/messages", label: "Anthropic API" },
        { href: "/docs/errors", label: "Error codes" },
      ],
    },
    {
      title: "Account",
      links: [
        { href: "/login", label: "Log in" },
        { href: "/signup", label: "Sign up" },
        { href: "/dashboard/billing", label: "Billing" },
      ],
    },
  ];
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader siteName={siteName} loggedIn={!!session} />
      <main className="flex-1">{children}</main>
      <footer className="border-t bg-card/30">
        <div className="mx-auto grid w-full max-w-6xl gap-8 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-3">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
                <Zap className="size-4" />
              </span>
              {siteName}
            </Link>
            <p className="max-w-xs text-sm text-muted-foreground">
              One API key and one base URL for OpenAI, Anthropic and Gemini compatible models. Metered, pay-as-you-go.
            </p>
            {supportEmail && (
              <a href={`mailto:${supportEmail}`} className="text-sm text-muted-foreground hover:text-foreground">
                {supportEmail}
              </a>
            )}
          </div>
          {cols.map((c) => (
            <div key={c.title} className="space-y-3 text-sm">
              <h3 className="font-medium">{c.title}</h3>
              <ul className="space-y-2 text-muted-foreground">
                {c.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="hover:text-foreground">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="border-t">
          <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-xs text-muted-foreground">
            <span>
              &copy; {new Date().getFullYear()} {siteName}. All rights reserved.
            </span>
            <span>Model names are trademarks of their respective owners.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
