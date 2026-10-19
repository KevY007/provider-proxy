"use client";

import { useState } from "react";
import { Ban, Eye, Power, PowerOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { CopyButton } from "@/components/common/copy-button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAction } from "@/components/admin/use-action";
import { revealApiKey, setApiKeyStatus } from "@/server/admin/keys-actions";

/** Admin-only: fetch the full key on demand (audited) and show it with a copy button. */
function RevealKey({ id, name }: { id: string; name: string }) {
  const { run, pending } = useAction();
  const [key, setKey] = useState<string | null>(null);
  return (
    <>
      <Button variant="ghost" size="sm" disabled={pending} onClick={() => run(() => revealApiKey(id), { refresh: false, onOk: (d) => setKey(d?.key ?? null) })}>
        <Eye className="size-3.5" /> Reveal
      </Button>
      <Dialog open={key !== null} onOpenChange={(o) => !o && setKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key &ldquo;{name}&rdquo;</DialogTitle>
            <DialogDescription>Treat it like a password. This view was recorded in the audit log.</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-2">
            <code className="min-w-0 flex-1 break-all font-mono text-sm">{key}</code>
            {key && <CopyButton value={key} />}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Enable / disable / revoke buttons for one customer API key. */
export function ApiKeyActions({ id, name, status }: { id: string; name: string; status: string }) {
  const { run, pending } = useAction();
  if (status === "REVOKED") return <span className="text-xs text-muted-foreground">Revoked</span>;
  return (
    <div className="flex items-center justify-end gap-1">
      <RevealKey id={id} name={name} />
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
