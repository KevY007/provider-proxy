import {
  Activity,
  BarChart3,
  BookOpen,
  Boxes,
  CreditCard,
  Cpu,
  FlaskConical,
  KeyRound,
  Layers,
  LayoutDashboard,
  LineChart,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  Timer,
  Users,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Match only this exact path (otherwise prefix match). Used for the overview items. */
  exact?: boolean;
  /** Opens in a new tab / leaves the shell (e.g. public docs). */
  external?: boolean;
  /** Hidden from SUPPORT staff (the page itself is admin-only). */
  adminOnly?: boolean;
}

export interface NavGroup {
  label?: string;
  items: NavItem[];
}

/**
 * Sidebar navigation. Other agents: add new pages by appending here (keep hrefs in sync with PLAN §8).
 * Titles are also used for the topbar breadcrumb.
 */
export const customerNav: NavGroup[] = [
  {
    items: [
      { title: "Overview", href: "/dashboard", icon: LayoutDashboard, exact: true },
      { title: "API Keys", href: "/dashboard/keys", icon: KeyRound },
      { title: "Usage", href: "/dashboard/usage", icon: BarChart3 },
      { title: "Logs", href: "/dashboard/logs", icon: ScrollText },
      { title: "Playground", href: "/dashboard/playground", icon: FlaskConical },
      { title: "Models & Pricing", href: "/dashboard/models", icon: Boxes },
    ],
  },
  {
    label: "Account",
    items: [
      { title: "Billing", href: "/dashboard/billing", icon: CreditCard },
      { title: "Settings", href: "/dashboard/settings", icon: Settings },
      { title: "Docs", href: "/docs", icon: BookOpen, external: true },
    ],
  },
];

export const adminNav: NavGroup[] = [
  {
    items: [
      { title: "Overview", href: "/admin", icon: LayoutDashboard, exact: true },
      { title: "Analytics", href: "/admin/analytics", icon: LineChart },
    ],
  },
  {
    label: "Catalog",
    items: [
      { title: "Providers", href: "/admin/providers", icon: Server },
      { title: "Models", href: "/admin/models", icon: Cpu, adminOnly: true },
      { title: "Groups", href: "/admin/groups", icon: Layers, adminOnly: true },
    ],
  },
  {
    label: "Customers",
    items: [
      { title: "Customers", href: "/admin/customers", icon: Users },
      { title: "API Keys", href: "/admin/keys", icon: KeyRound },
      { title: "Logs", href: "/admin/logs", icon: ScrollText },
      { title: "Billing", href: "/admin/billing", icon: CreditCard },
    ],
  },
  {
    label: "System",
    items: [
      { title: "Status", href: "/admin/status", icon: Activity },
      { title: "Latency", href: "/admin/latency", icon: Timer },
      { title: "Settings", href: "/admin/settings", icon: Settings },
      { title: "Audit Log", href: "/admin/audit", icon: ShieldCheck },
    ],
  },
];

/** Drops admin-only items (and groups left empty) for everyone but ADMIN, so SUPPORT never sees links that bounce. */
export function navForRole(groups: NavGroup[], role: "CUSTOMER" | "SUPPORT" | "ADMIN"): NavGroup[] {
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.adminOnly || role === "ADMIN") }))
    .filter((g) => g.items.length > 0);
}

export function isNavActive(item: NavItem, pathname: string): boolean {
  if (item.external) return false;
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(item.href + "/");
}

export function findNavItem(groups: NavGroup[], pathname: string): NavItem | undefined {
  let best: NavItem | undefined;
  for (const g of groups) {
    for (const item of g.items) {
      if (isNavActive(item, pathname) && (!best || item.href.length > best.href.length)) best = item;
    }
  }
  return best;
}
