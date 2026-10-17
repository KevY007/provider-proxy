import { describe, expect, it } from "vitest";
import { adminNav, customerNav, navForRole } from "@/components/shell/nav";

const hrefs = (groups: ReturnType<typeof navForRole>) => groups.flatMap((g) => g.items.map((i) => i.href));

describe("navForRole", () => {
  it("shows every admin page to ADMIN", () => {
    const all = adminNav.flatMap((g) => g.items.map((i) => i.href));
    expect(hrefs(navForRole(adminNav, "ADMIN"))).toEqual(all);
  });

  it("hides admin-only pages (models, groups) from SUPPORT so the sidebar never links to a redirect", () => {
    const h = hrefs(navForRole(adminNav, "SUPPORT"));
    expect(h).not.toContain("/admin/models");
    expect(h).not.toContain("/admin/groups");
    expect(h).toContain("/admin/customers");
    expect(h).toContain("/admin/providers");
  });

  it("leaves the customer nav untouched", () => {
    expect(navForRole(customerNav, "CUSTOMER")).toEqual(customerNav);
  });

  it("drops groups that end up empty", () => {
    const groups = [{ label: "x", items: [{ title: "A", href: "/a", icon: adminNav[0].items[0].icon, adminOnly: true }] }];
    expect(navForRole(groups, "SUPPORT")).toEqual([]);
  });
});
