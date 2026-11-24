"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { getSettings, setSettings, SETTING_DEFS, type SettingKey, type SettingValues } from "@/lib/settings";
import { invalidateGatewayConfig } from "@/gateway/cache";
import { armTimers } from "@/server/maintenance";
import { pricingTargetsSchema, unavailablePricingTarget } from "@/server/pricing/price-sync/targets";
import { getPricingPoolOptions } from "./price-sync-queries";
import { ActionFail, adminAction, parseInput } from "./action";
import { friendlySettingIssue, type IssueLike } from "./settings-calc";

/**
 * Save changed settings. `values` is { key: value } for any subset of SETTING_DEFS keys; each value is validated
 * with that key's own zod schema (number inputs may arrive as numeric strings). Only differing keys are written.
 */
export async function saveSettings(values: Record<string, unknown>) {
  return adminAction<{ changed: string[] }>({ adminOnly: true }, async ({ admin, ip }) => {
    const current = await getSettings();
    const fieldErrors: Record<string, string> = {};
    const next: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(values ?? {})) {
      if (key === "priceSyncPool" || key === "priceSyncModel") {
        fieldErrors[key] = "Choose pool and model pairs in Price sync AI routes.";
        continue;
      }
      if (key === "priceSyncTargets") {
        const parsed = pricingTargetsSchema.safeParse(raw);
        if (!parsed.success) fieldErrors[key] = parsed.error.issues[0].message;
        else {
          const invalid = unavailablePricingTarget(parsed.data, await getPricingPoolOptions());
          if (invalid) fieldErrors[key] = `No configured chat route for ${invalid.model} in pool ${invalid.pool}.`;
          else if (JSON.stringify(parsed.data) !== JSON.stringify(current.priceSyncTargets)) next[key] = parsed.data;
        }
        continue;
      }
      if (!(key in SETTING_DEFS)) {
        fieldErrors[key] = "Unknown setting";
        continue;
      }
      const def = SETTING_DEFS[key as SettingKey];
      let v: unknown = raw;
      if (def.type === "number") v = typeof raw === "string" ? (raw.trim() === "" ? NaN : Number(raw)) : raw;
      const res = (def.schema as z.ZodType).safeParse(v);
      if (!res.success) {
        fieldErrors[key] = friendlySettingIssue(def.label, res.error.issues[0] as IssueLike | undefined);
        continue;
      }
      if (JSON.stringify(res.data) !== JSON.stringify((current as Record<string, unknown>)[key])) next[key] = res.data;
    }
    if (Object.keys(fieldErrors).length) {
      const msgs = Object.values(fieldErrors);
      throw new ActionFail(msgs.length === 1 ? msgs[0] : `${msgs[0]} (and ${msgs.length - 1} more setting${msgs.length === 2 ? "" : "s"} to fix)`, fieldErrors);
    }
    const changed = Object.keys(next);
    if (changed.length === 0) return { data: { changed }, message: "No changes to save" };
    await setSettings(next as Partial<SettingValues>);
    const diff = Object.fromEntries(changed.map((k) => [k, { from: (current as Record<string, unknown>)[k], to: next[k] }]));
    await audit(admin.id, "settings.update", { type: "Setting", id: changed.join(",").slice(0, 100) }, { changed: diff }, ip);
    await invalidateGatewayConfig("settings");
    armTimers(await getSettings()); // monitoring switches take effect now on this instance (others on their next activity / tick)
    return { data: { changed }, message: `Saved ${changed.length} setting${changed.length === 1 ? "" : "s"}` };
  });
}

// ---------------------------------------------------------------- announcements

const announcementSchema = z.object({
  title: z.string().trim().min(1, "Required").max(120),
  body: z.string().trim().min(1, "Required").max(2000),
  level: z.enum(["info", "success", "warning", "error"]).default("info"),
  active: z.boolean().default(true),
});

export async function createAnnouncement(input: unknown) {
  return adminAction<{ id: string }>({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(announcementSchema, input);
    const a = await db.announcement.create({ data: d, select: { id: true } });
    await audit(admin.id, "announcement.create", { type: "Announcement", id: a.id }, { title: d.title, level: d.level }, ip);
    return { data: { id: a.id }, message: "Announcement created" };
  });
}

export async function updateAnnouncement(id: string, input: unknown) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const d = parseInput(announcementSchema, input);
    await db.announcement.update({ where: { id }, data: d });
    await audit(admin.id, "announcement.update", { type: "Announcement", id }, { title: d.title, level: d.level, active: d.active }, ip);
    return { message: "Announcement saved" };
  });
}

export async function setAnnouncementActive(id: string, active: boolean) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    await db.announcement.update({ where: { id }, data: { active: Boolean(active) } });
    await audit(admin.id, active ? "announcement.activate" : "announcement.deactivate", { type: "Announcement", id }, {}, ip);
    return { message: active ? "Announcement is live" : "Announcement hidden" };
  });
}

export async function deleteAnnouncement(id: string) {
  return adminAction({ adminOnly: true }, async ({ admin, ip }) => {
    const a = await db.announcement.findUnique({ where: { id }, select: { title: true } });
    if (!a) throw new ActionFail("Announcement not found");
    await db.announcement.delete({ where: { id } });
    await audit(admin.id, "announcement.delete", { type: "Announcement", id }, { title: a.title }, ip);
    return { message: "Announcement deleted" };
  });
}
