import { PageHeader } from "@/components/common/page-header";
import { Announcements } from "@/components/admin/settings/announcements";
import { SettingsForm, type SettingField } from "@/components/admin/settings/settings-form";
import { PricingRoutesForm } from "@/components/admin/settings/pricing-routes-form";
import { getPricingPoolOptions } from "@/server/admin/price-sync-queries";
import { pricingTargets } from "@/server/pricing/price-sync/targets";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/auth/session";
import { getSettings, SETTING_DEFS, SETTING_KEYS } from "@/lib/settings";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function Page() {
  const { user } = await requireAdmin();
  const [values, options, announcements] = await Promise.all([
    getSettings(),
    getPricingPoolOptions(),
    db.announcement.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  const fields: SettingField[] = SETTING_KEYS.filter((key) => key !== "priceSyncPool" && key !== "priceSyncModel" && key !== "priceSyncTargets").map((key) => {
    const def = SETTING_DEFS[key];
    return {
      key,
      label: def.label,
      description: def.description,
      group: def.group,
      type: def.type as SettingField["type"],
      value: values[key] as SettingField["value"],
      default: def.default as SettingField["default"],
    };
  });
  const canEdit = user.role === "ADMIN";
  return (
    <>
      <PageHeader title="Settings" description="Platform-wide runtime settings. Changes take effect within seconds, no restart needed." />
      <div className="space-y-6">
        <PricingRoutesForm initial={pricingTargets(values)} options={options} canEdit={canEdit} />
        <SettingsForm fields={fields} canEdit={canEdit} />
        <Announcements
          canEdit={canEdit}
          rows={announcements.map((a) => ({ id: a.id, title: a.title, body: a.body, level: a.level, active: a.active, createdAt: a.createdAt.toISOString() }))}
        />
      </div>
    </>
  );
}
