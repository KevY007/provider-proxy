"use client";

import { useState } from "react";
import { BadgeCheck, Save, ShieldAlert, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { StatusBadge } from "@/components/common/status-badge";
import { NumberField, SelectField } from "@/components/admin/fields";
import { useAction } from "@/components/admin/use-action";
import { fmtDateTime } from "@/components/admin/format";
import { setCustomerRole, setCustomerStatus, updateCustomerSettings, verifyCustomerEmail } from "@/server/admin/customers-actions";
import type { CustomerDetail } from "@/server/admin/customers-queries";

export function CustomerControls({
  user,
  groups,
  isAdmin,
  isSelf,
}: {
  user: CustomerDetail["user"];
  groups: Array<{ id: string; name: string; isDefault: boolean }>;
  isAdmin: boolean;
  isSelf: boolean;
}) {
  const { run, pending, fieldErrors } = useAction();
  const [role, setRole] = useState(user.role);
  const [groupId, setGroupId] = useState(user.groupId ?? "");
  const [multiplier, setMultiplier] = useState(user.priceMultiplier ?? "");
  const [billingMode, setBillingMode] = useState(user.billingMode);
  const [creditLimit, setCreditLimit] = useState(user.creditLimit === "0" ? "" : user.creditLimit);
  const [monthlyLimit, setMonthlyLimit] = useState(user.monthlySpendLimit ?? "");
  const [maxConc, setMaxConc] = useState(user.maxConcurrency?.toString() ?? "");
  const staff = user.role !== "CUSTOMER";
  const suspended = user.status === "SUSPENDED";
  const unverified = !user.emailVerifiedAt || user.status === "PENDING_VERIFICATION";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile &amp; controls</CardTitle>
        <CardDescription>Changes apply to the gateway within seconds. Every change is written to the audit log.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <StatusBadge status={user.status} />
              {user.role !== "CUSTOMER" && <StatusBadge status={user.role} dot={false} />}
              {user.totpEnabled && <StatusBadge status="ACTIVE" label="2FA on" dot={false} />}
            </div>
            <p className="text-xs text-muted-foreground">
              {user.emailVerifiedAt ? `Email verified ${fmtDateTime(user.emailVerifiedAt, false)} UTC` : "Email not verified"} · last login{" "}
              {user.lastLoginAt ? `${fmtDateTime(user.lastLoginAt, false)} UTC` : "never"}
            </p>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {unverified && (
              <Button variant="outline" size="sm" disabled={pending} onClick={() => run(() => verifyCustomerEmail(user.id))}>
                <BadgeCheck className="size-4" /> Verify email
              </Button>
            )}
            {suspended ? (
              <Button size="sm" disabled={pending || isSelf} onClick={() => run(() => setCustomerStatus(user.id, "ACTIVE"))}>
                <UserCheck className="size-4" /> Activate
              </Button>
            ) : (
              <ConfirmDialog
                destructive
                title={`Suspend ${user.email}?`}
                description="They are signed out of the dashboard immediately and all their API keys stop working until you activate the account again."
                confirmLabel="Suspend"
                trigger={
                  <Button variant="destructive" size="sm" disabled={pending || isSelf || (staff && !isAdmin)}>
                    <ShieldAlert className="size-4" /> Suspend
                  </Button>
                }
                onConfirm={async () => {
                  const r = await run(() => setCustomerStatus(user.id, "SUSPENDED"));
                  if (!r.ok) throw new Error(r.error);
                }}
              />
            )}
          </div>
        </div>

        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() =>
              updateCustomerSettings({ userId: user.id, groupId, priceMultiplier: multiplier, billingMode, creditLimit, monthlySpendLimit: monthlyLimit, maxConcurrency: maxConc }),
            );
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Group (pool)"
              value={groupId}
              onChange={setGroupId}
              allowNone
              noneLabel="Default group"
              options={groups.map((g) => ({ value: g.id, label: g.isDefault ? `${g.name} (default)` : g.name }))}
              error={fieldErrors.groupId}
              disabled={!isAdmin}
            />
            <NumberField
              label="Price multiplier"
              value={multiplier}
              onChange={setMultiplier}
              placeholder="blank = group only"
              step="0.01"
              description="Stacks on top of the group multiplier."
              error={fieldErrors.priceMultiplier}
              disabled={!isAdmin}
            />
            <SelectField
              label="Billing mode"
              value={billingMode}
              onChange={(v) => setBillingMode(v as typeof billingMode)}
              options={[
                { value: "PREPAID", label: "Prepaid (balance must stay positive)" },
                { value: "POSTPAID", label: "Postpaid (may go negative up to credit limit)" },
              ]}
              disabled={!isAdmin}
            />
            <NumberField label="Credit limit" suffix="USD" value={creditLimit} onChange={setCreditLimit} placeholder="0" min={0} description="How far below $0 the balance may go." error={fieldErrors.creditLimit} disabled={!isAdmin} />
            <NumberField label="Monthly spend limit" suffix="USD" value={monthlyLimit} onChange={setMonthlyLimit} placeholder="no limit" min={0} error={fieldErrors.monthlySpendLimit} disabled={!isAdmin} />
            <NumberField label="Max concurrency" value={maxConc} onChange={setMaxConc} placeholder="default" step="1" min={1} description="Concurrent in-flight requests across all their keys." error={fieldErrors.maxConcurrency} disabled={!isAdmin} />
          </div>
          <div className="flex items-center justify-between gap-2">
            {!isAdmin && <p className="text-xs text-muted-foreground">Only admins can change billing and limit settings.</p>}
            <Button type="submit" className="ml-auto" disabled={pending || !isAdmin}>
              <Save className="size-4" /> Save settings
            </Button>
          </div>
        </form>

        <div className="flex flex-wrap items-end gap-3 border-t pt-4">
          <SelectField
            className="w-56"
            label="Role"
            value={role}
            onChange={(v) => setRole(v as typeof role)}
            options={[
              { value: "CUSTOMER", label: "Customer" },
              { value: "SUPPORT", label: "Support (read + limited actions)" },
              { value: "ADMIN", label: "Admin (full access)" },
            ]}
            disabled={!isAdmin || isSelf}
            description={isSelf ? "You cannot change your own role." : undefined}
          />
          <ConfirmDialog
            title={`Change role to ${role}?`}
            description={role === "ADMIN" ? "This grants full control over providers, pricing, money and other customers." : "Their access to the admin console changes immediately."}
            confirmLabel="Change role"
            destructive={role === "ADMIN"}
            trigger={
              <Button variant="outline" disabled={pending || !isAdmin || isSelf || role === user.role}>
                Update role
              </Button>
            }
            onConfirm={async () => {
              const r = await run(() => setCustomerRole(user.id, role as "CUSTOMER" | "SUPPORT" | "ADMIN"));
              if (!r.ok) throw new Error(r.error);
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
