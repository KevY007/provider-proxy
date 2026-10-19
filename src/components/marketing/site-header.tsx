"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { BrandMark } from "@/components/common/brand-mark";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/docs", label: "Docs" },
  { href: "/pricing", label: "Pricing" },
  { href: "/status", label: "Status" },
];

/** Sticky public header with desktop nav and a mobile sheet menu. */
export function SiteHeader({
  siteName,
  loggedIn,
  showPricing = true,
  showStatus = true,
}: {
  siteName: string;
  loggedIn: boolean;
  showPricing?: boolean;
  showStatus?: boolean;
}) {
  const nav = NAV.filter((n) => (n.href !== "/pricing" || showPricing) && (n.href !== "/status" || showStatus));
  const pathname = usePathname();
  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm shadow-primary/30">
            <BrandMark />
          </span>
          {siteName}
        </Link>
        <nav className="hidden items-center gap-1 text-sm md:flex" aria-label="Main">
          {nav.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={cn(
                "rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                active(n.href) && "bg-muted text-foreground",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          {loggedIn ? (
            <Button asChild size="sm">
              <Link href="/dashboard">Dashboard</Link>
            </Button>
          ) : (
            <>
              <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
                <Link href="/login">Log in</Link>
              </Button>
              <Button asChild size="sm" className="hidden sm:inline-flex">
                <Link href="/signup">Get started</Link>
              </Button>
            </>
          )}
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                <Menu className="size-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetHeader>
                <SheetTitle>{siteName}</SheetTitle>
              </SheetHeader>
              <div className="flex flex-col gap-1 px-4">
                {nav.map((n) => (
                  <SheetClose asChild key={n.href}>
                    <Link href={n.href} className={cn("rounded-md px-3 py-2 text-sm hover:bg-muted", active(n.href) && "bg-muted font-medium")}>
                      {n.label}
                    </Link>
                  </SheetClose>
                ))}
                <div className="mt-4 flex flex-col gap-2 border-t pt-4">
                  {loggedIn ? (
                    <SheetClose asChild>
                      <Button asChild>
                        <Link href="/dashboard">Dashboard</Link>
                      </Button>
                    </SheetClose>
                  ) : (
                    <>
                      <SheetClose asChild>
                        <Button asChild variant="outline">
                          <Link href="/login">Log in</Link>
                        </Button>
                      </SheetClose>
                      <SheetClose asChild>
                        <Button asChild>
                          <Link href="/signup">Get started</Link>
                        </Button>
                      </SheetClose>
                    </>
                  )}
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
