import "server-only";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import type { AnnouncementItem } from "./announcements-bell";

/** Server-side data every shell layout needs (site name, announcements, sidebar state). */
export async function getShellData(): Promise<{
  siteName: string;
  customerBilling: boolean;
  announcements: AnnouncementItem[];
  defaultOpen: boolean;
}> {
  const [siteName, customerBilling, rows, jar] = await Promise.all([
    getSetting("siteName"),
    getSetting("customerBilling"),
    db.announcement
      .findMany({ where: { active: true }, orderBy: { createdAt: "desc" }, take: 10 })
      .catch(() => []),
    cookies(),
  ]);
  return {
    siteName,
    customerBilling,
    announcements: rows.map((a) => ({
      id: a.id,
      title: a.title,
      body: a.body,
      level: a.level,
      createdAt: a.createdAt.toISOString(),
    })),
    defaultOpen: jar.get("sidebar_state")?.value !== "false",
  };
}
