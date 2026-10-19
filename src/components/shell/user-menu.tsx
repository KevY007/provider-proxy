"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { BookOpen, LayoutDashboard, LogOut, Settings, Shield } from "lucide-react";
import { toast } from "sonner";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logoutAction } from "@/lib/auth/actions";
import { initials } from "@/lib/utils";

export interface ShellUser {
  name: string | null;
  email: string;
  role: "CUSTOMER" | "SUPPORT" | "ADMIN";
}

export function UserMenu({ user, variant }: { user: ShellUser; variant: "customer" | "admin" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const isStaff = user.role !== "CUSTOMER";

  function logout() {
    start(async () => {
      await logoutAction();
      toast.success("Signed out");
      router.replace("/login");
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account menu">
          <Avatar className="size-8">
            <AvatarFallback className="bg-primary/15 text-xs font-semibold text-primary">
              {initials(user.name ?? user.email)}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="space-y-0.5 font-normal">
          <div className="truncate text-sm font-medium">{user.name ?? user.email.split("@")[0]}</div>
          <div className="truncate text-xs text-muted-foreground">{user.email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={variant === "admin" ? "/admin/settings" : "/dashboard/settings"}>
            <Settings className="size-4" /> Settings
          </Link>
        </DropdownMenuItem>
        {isStaff && variant === "customer" && (
          <DropdownMenuItem asChild>
            <Link href="/admin">
              <Shield className="size-4" /> Admin console
            </Link>
          </DropdownMenuItem>
        )}
        {variant === "admin" && (
          <DropdownMenuItem asChild>
            <Link href="/dashboard">
              <LayoutDashboard className="size-4" /> Customer dashboard
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link href="/docs">
            <BookOpen className="size-4" /> Documentation
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={pending} onSelect={logout} variant="destructive">
          <LogOut className="size-4" /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
