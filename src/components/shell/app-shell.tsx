"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";
import { ChevronRight, Eye, Wallet, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { MoneyText } from "@/components/common/money-text";
import { stopImpersonationAction } from "@/lib/auth/actions";
import { cn } from "@/lib/utils";
import { AnnouncementsBell, type AnnouncementItem } from "./announcements-bell";
import { adminNav, customerNav, findNavItem, isNavActive, type NavGroup } from "./nav";
import { ThemeToggle } from "./theme-toggle";
import { UserMenu, type ShellUser } from "./user-menu";

export interface AppShellProps {
  /** Which navigation / chrome to render. */
  variant: "customer" | "admin";
  user: ShellUser;
  /** Customer balance as a decimal string; shows the balance pill when provided. */
  balance?: string | null;
  siteName?: string;
  announcements?: AnnouncementItem[];
  /** Email of the customer being impersonated (shows a banner with an exit button). */
  impersonating?: string | null;
  /** Initial sidebar open state (read from the `sidebar_state` cookie by the layout). */
  defaultOpen?: boolean;
  children: React.ReactNode;
}

/**
 * Shared application shell: collapsible sidebar + topbar (breadcrumb title, balance pill,
 * announcements bell, theme toggle, user menu). Used by `/dashboard/*` and `/admin/*` layouts.
 */
export function AppShell({
  variant,
  user,
  balance,
  siteName = "ProviderProxy",
  announcements = [],
  impersonating,
  defaultOpen = true,
  children,
}: AppShellProps) {
  const pathname = usePathname();
  const groups: NavGroup[] = variant === "admin" ? adminNav : customerNav;
  const current = findNavItem(groups, pathname);
  const section = variant === "admin" ? "Admin" : siteName;

  return (
    <SidebarProvider defaultOpen={defaultOpen}>
      <Sidebar collapsible="icon" variant="sidebar">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild tooltip={siteName}>
                <Link href={variant === "admin" ? "/admin" : "/dashboard"}>
                  <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Zap className="size-4" />
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">{siteName}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {variant === "admin" ? "Admin console" : "Developer dashboard"}
                    </span>
                  </div>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((group, gi) => (
            <SidebarGroup key={group.label ?? gi}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={isNavActive(item, pathname)} tooltip={item.title}>
                        <Link href={item.href}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        <SidebarFooter>
          <div className="px-2 pb-1 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            {user.email}
          </div>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>

      <SidebarInset className="min-w-0">
        {impersonating && <ImpersonationBanner email={impersonating} />}
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <SidebarTrigger className="-ml-1" />
          <Separator orientation="vertical" className="mr-1 h-5" />
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="hidden truncate text-muted-foreground sm:inline">{section}</span>
            <ChevronRight className="hidden size-3.5 text-muted-foreground sm:inline" />
            <span className="truncate font-medium">{current?.title ?? "Page"}</span>
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            {variant === "customer" && balance != null && <BalancePill balance={balance} />}
            <AnnouncementsBell items={announcements} />
            <ThemeToggle />
            <UserMenu user={user} variant={variant} />
          </div>
        </header>
        <main className="flex-1 p-4 md:p-6 lg:p-8">
          <div className="mx-auto w-full max-w-7xl">{children}</div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function BalancePill({ balance }: { balance: string }) {
  const low = Number(balance) < 1;
  return (
    <Button asChild variant="outline" size="sm" className={cn("gap-1.5 rounded-full", low && "border-amber-500/50 text-amber-500")}>
      <Link href="/dashboard/billing" aria-label="Balance - open billing">
        <Wallet className="size-3.5" />
        <MoneyText value={balance} />
      </Link>
    </Button>
  );
}

function ImpersonationBanner({ email }: { email: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="flex items-center justify-center gap-3 bg-amber-500 px-4 py-1.5 text-sm font-medium text-black">
      <Eye className="size-4" />
      <span>You are viewing the dashboard as {email}</span>
      <Button
        size="sm"
        variant="secondary"
        className="h-6"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await stopImpersonationAction();
            if (res.ok && res.data) {
              router.replace(res.data.redirectTo);
              router.refresh();
            } else toast.error(res.ok ? "Failed" : res.error);
          })
        }
      >
        Exit
      </Button>
    </div>
  );
}
