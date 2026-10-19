"use client";

import { KeyRound, LogOut, Mail, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { useAction } from "@/components/admin/use-action";
import { impersonateCustomer, revokeCustomerSessions, sendCustomerPasswordReset } from "@/server/admin/customers-actions";

/** Header actions on the customer detail page. */
export function CustomerHeaderActions({ userId, email, canImpersonate, isSelf }: { userId: string; email: string; canImpersonate: boolean; isSelf: boolean }) {
  const { run, pending } = useAction();
  return (
    <>
      <ConfirmDialog
        title={`Impersonate ${email}?`}
        description="You'll be signed in as this customer in the dashboard (your admin session is replaced until you exit via the banner). The action is recorded in the audit log."
        confirmLabel="Impersonate"
        trigger={
          <Button variant="outline" size="sm" disabled={pending || isSelf || !canImpersonate}>
            <UserCog className="size-4" /> Impersonate
          </Button>
        }
        onConfirm={async () => {
          const r = await run(() => impersonateCustomer(userId), {
            refresh: false,
            onOk: (d) => {
              window.location.assign(d?.redirectTo ?? "/dashboard");
            },
          });
          if (!r.ok) throw new Error(r.error);
        }}
      />
      <ConfirmDialog
        title="Send password-reset email?"
        description={`A one-hour reset link is emailed to ${email}. Their current password keeps working until they use it.`}
        confirmLabel="Send email"
        trigger={
          <Button variant="outline" size="sm" disabled={pending}>
            <Mail className="size-4" /> Password reset
          </Button>
        }
        onConfirm={async () => {
          const r = await run(() => sendCustomerPasswordReset(userId), { refresh: false });
          if (!r.ok) throw new Error(r.error);
        }}
      />
      <ConfirmDialog
        destructive
        title="Revoke all sessions?"
        description="The customer is signed out everywhere and has to log in again. API keys are unaffected."
        confirmLabel="Revoke sessions"
        trigger={
          <Button variant="outline" size="sm" disabled={pending || isSelf}>
            <LogOut className="size-4" /> Revoke sessions
          </Button>
        }
        onConfirm={async () => {
          const r = await run(() => revokeCustomerSessions(userId));
          if (!r.ok) throw new Error(r.error);
        }}
      />
      <Button variant="ghost" size="sm" asChild>
        <a href={`/admin/keys?q=${encodeURIComponent(email)}`}>
          <KeyRound className="size-4" /> All keys
        </a>
      </Button>
    </>
  );
}
