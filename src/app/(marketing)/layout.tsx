import Link from "next/link";
import { Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/shell/theme-toggle";

/** Minimal public layout. The Customer-portal agent replaces/extends this with the full marketing site. */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Zap className="size-4" />
            </span>
            ProviderProxy
          </Link>
          <nav className="hidden gap-5 text-sm text-muted-foreground sm:flex">
            <Link href="/pricing" className="hover:text-foreground">Pricing</Link>
            <Link href="/docs" className="hover:text-foreground">Docs</Link>
            <Link href="/status" className="hover:text-foreground">Status</Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <Button asChild variant="ghost" size="sm"><Link href="/login">Log in</Link></Button>
            <Button asChild size="sm"><Link href="/signup">Sign up</Link></Button>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10">{children}</main>
    </div>
  );
}
