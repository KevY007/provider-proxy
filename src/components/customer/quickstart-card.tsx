import Link from "next/link";
import { ArrowRight, CircleDot, KeyRound, Wallet, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CodeBlock } from "./code-block";
import { buildSnippets } from "./snippets";

/** Onboarding card shown on the overview until the customer has created an API key. */
export function QuickstartCard({ appUrl, hasBalance, siteName }: { appUrl: string; hasBalance: boolean; siteName: string }) {
  const curl = buildSnippets({ appUrl, siteName })[0].blocks[0];
  const steps = [
    { icon: Wallet, title: "Add balance", text: hasBalance ? "You have credit available." : "Pay as you go. Add funds whenever you need.", href: "/dashboard/billing", cta: hasBalance ? "View billing" : "Add funds" },
    { icon: KeyRound, title: "Create an API key", text: "Pick a pool, limit models and spend if you like.", href: "/dashboard/keys", cta: "Create key" },
    { icon: Zap, title: "Make a request", text: "Use the snippet or open the playground.", href: "/dashboard/playground", cta: "Open playground" },
  ];
  return (
    <Card className="mb-6 border-primary/30 bg-gradient-to-br from-primary/5 to-transparent">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CircleDot className="size-4 text-primary" /> Get started with {siteName}
        </CardTitle>
        <CardDescription>Three steps to your first request. Use the same base URL for OpenAI, Anthropic and Gemini compatible clients.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-2">
        <ol className="space-y-4">
          {steps.map((s, i) => (
            <li key={s.title} className="flex items-start gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{s.title}</p>
                <p className="text-sm text-muted-foreground">{s.text}</p>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href={s.href}>
                  {s.cta} <ArrowRight className="size-3.5" />
                </Link>
              </Button>
            </li>
          ))}
        </ol>
        <CodeBlock block={curl} maxHeight="14rem" />
      </CardContent>
    </Card>
  );
}
