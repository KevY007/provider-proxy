"use client";

import { Ban, Power, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { useAction } from "@/components/admin/use-action";
import { setApiKeyStatus } from "@/server/admin/keys-actions";

/** Enable / disable / revoke buttons for one customer API key. */
export function ApiKeyActions({ id, name, status }: { id: string; name: string; status: string }) {
  const { run, pending } = useAction();
  if (status === "REVOKED") return <span className="text-xs text-muted-foreground">Revoked</span>;
  return (
    <div className="flex items-center justify-end gap-1">
      {status === "ACTIVE" ? (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => setApiKeyStatus(id, "DISABLED"))}>
          <PowerOff className="size-3.5" /> Disable
        </Button>
      ) : (
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => setApiKeyStatus(id, "ACTIVE"))}>
          <Power className="size-3.5" /> Enable
        </Button>
      )}
      <ConfirmDialog
        destructive
        title={`Revoke key "${name}"?`}
        description="The key stops working immediately and cannot be re-enabled. The customer must create a new key."
        confirmLabel="Revoke key"
        trigger={
          <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-500" disabled={pending}>
            <Ban className="size-3.5" /> Revoke
          </Button>
        }
        onConfirm={async () => {
          const res = await run(() => setApiKeyStatus(id, "REVOKED"));
          if (!res.ok) throw new Error(res.error);
        }}
      />
    </div>
  );
}
