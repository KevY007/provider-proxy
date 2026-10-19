"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Ban, KeyRound, MoreHorizontal, Pencil, Plus, Power, PowerOff, Terminal, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { CopyButton } from "@/components/common/copy-button";
import { DataTable } from "@/components/common/data-table";
import { EmptyState } from "@/components/common/empty-state";
import { MoneyText } from "@/components/common/money-text";
import { StatusBadge } from "@/components/common/status-badge";
import { formatCompact } from "@/lib/utils";
import { revokeKeyAction, setKeyEnabledAction, type CreatedKey } from "@/server/customer/keys";
import { formatMultiplier } from "@/server/customer/pricing";
import type { KeyRow, PoolOption } from "@/server/customer/portal-data";
import { KeyFormDialog } from "./key-form-dialog";
import { LocalTime } from "./local-time";
import type { ModelOption } from "./snippet-tabs";
import { UseKeyDialog } from "./use-key-dialog";
import { VerifyBanner } from "./verify-banner";

export interface KeysClientProps {
  keys: KeyRow[];
  pools: PoolOption[];
  currentPool: PoolOption | null;
  models: ModelOption[];
  appUrl: string;
  siteName: string;
  emailVerified: boolean;
  email: string;
}

export function KeysClient({ keys, pools, currentPool, models, appUrl, siteName, emailVerified, email }: KeysClientProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<KeyRow | null>(null);
  const [created, setCreated] = useState<(CreatedKey & { name: string; allowedModels: string[] }) | null>(null);
  const [useKey, setUseKey] = useState<{ name: string; apiKey: string | null; allowedModels: string[] } | null>(null);
  const [revoking, setRevoking] = useState<KeyRow | null>(null);

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  async function toggle(k: KeyRow) {
    const enable = k.status !== "ACTIVE";
    const r = await setKeyEnabledAction({ id: k.id, enabled: enable });
    if (r.ok) toast.success(r.message);
    else toast.error(r.error);
  }

  const columns = useMemo<ColumnDef<KeyRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.original.name}</p>
            <p className="font-mono text-xs text-muted-foreground">{row.original.prefix}…</p>
          </div>
        ),
      },
      {
        id: "pool",
        header: "Pool",
        accessorFn: (k) => (k.groupName ? `${k.groupName} ${formatMultiplier(k.groupMultiplier ?? 1)}` : "Account default"),
        cell: ({ row }) =>
          row.original.groupName ? (
            <span className="whitespace-nowrap">
              {row.original.groupName} <span className="text-muted-foreground">{formatMultiplier(row.original.groupMultiplier ?? 1)}</span>
            </span>
          ) : (
            <span className="whitespace-nowrap text-muted-foreground">Account default</span>
          ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (k) => (k.expired && k.status === "ACTIVE" ? "EXPIRED" : k.status),
        cell: ({ row }) =>
          row.original.expired && row.original.status === "ACTIVE" ? <StatusBadge status="EXPIRED" tone="warning" /> : <StatusBadge status={row.original.status} />,
      },
      {
        id: "models",
        header: "Models",
        accessorFn: (k) => (k.allowedModels.length ? k.allowedModels.join(" ") : "all"),
        cell: ({ row }) => {
          const m = row.original.allowedModels;
          if (m.length === 0) return <span className="text-muted-foreground">All</span>;
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="cursor-default">
                  {m.length} model{m.length === 1 ? "" : "s"}
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs font-mono text-xs">{m.join(", ")}</TooltipContent>
            </Tooltip>
          );
        },
      },
      {
        id: "limits",
        header: "Limits",
        enableSorting: false,
        accessorFn: (k) => [k.rpmLimit && `${k.rpmLimit} rpm`, k.tpmLimit && `${k.tpmLimit} tpm`, k.maxConcurrency && `${k.maxConcurrency} conc`, k.ipAllowlist.length && `${k.ipAllowlist.length} IPs`].filter(Boolean).join(" / "),
        cell: ({ row }) => {
          const k = row.original;
          const parts = [
            k.rpmLimit ? `${formatCompact(k.rpmLimit)} rpm` : null,
            k.tpmLimit ? `${formatCompact(k.tpmLimit)} tpm` : null,
            k.maxConcurrency ? `${k.maxConcurrency} conc` : null,
            k.ipAllowlist.length ? `${k.ipAllowlist.length} IP${k.ipAllowlist.length === 1 ? "" : "s"}` : null,
          ].filter(Boolean);
          return parts.length ? (
            <div className="flex flex-wrap gap-1">
              {parts.map((p) => (
                <Badge key={p} variant="outline" className="font-normal">
                  {p}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">None</span>
          );
        },
      },
      {
        id: "spent",
        header: "Spent",
        accessorFn: (k) => Number(k.spent),
        meta: { className: "min-w-36" },
        cell: ({ row }) => {
          const k = row.original;
          const pct = k.spendLimit ? Math.min(100, (Number(k.spent) / Number(k.spendLimit)) * 100) : null;
          return (
            <div className="space-y-1">
              <div className="whitespace-nowrap text-sm">
                <MoneyText value={k.spent} />
                {k.spendLimit && (
                  <span className="text-muted-foreground">
                    {" / "}
                    <MoneyText value={k.spendLimit} />
                  </span>
                )}
              </div>
              {pct !== null && <Progress value={pct} className={pct >= 90 ? "[&>div]:bg-red-500" : undefined} />}
            </div>
          );
        },
      },
      {
        id: "lastUsed",
        header: "Last used",
        accessorFn: (k) => k.lastUsedAt ?? "",
        cell: ({ row }) => (row.original.lastUsedAt ? <LocalTime iso={row.original.lastUsedAt} mode="relative" className="whitespace-nowrap" /> : <span className="text-muted-foreground">Never</span>),
      },
      {
        id: "created",
        header: "Created",
        accessorFn: (k) => k.createdAt,
        cell: ({ row }) => <LocalTime iso={row.original.createdAt} mode="date" className="whitespace-nowrap text-muted-foreground" />,
      },
      {
        id: "actions",
        header: "",
        enableSorting: false,
        enableHiding: false,
        meta: { noExport: true, className: "w-10" },
        cell: ({ row }) => {
          const k = row.original;
          const revoked = k.status === "REVOKED";
          return (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${k.name}`}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setUseKey({ name: k.name, apiKey: null, allowedModels: k.allowedModels })}>
                  <Terminal className="size-4" /> Use key
                </DropdownMenuItem>
                {!revoked && (
                  <>
                    <DropdownMenuItem
                      onSelect={() => {
                        setEditing(k);
                        setFormOpen(true);
                      }}
                    >
                      <Pencil className="size-4" /> Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void toggle(k)}>
                      {k.status === "ACTIVE" ? (
                        <>
                          <PowerOff className="size-4" /> Disable
                        </>
                      ) : (
                        <>
                          <Power className="size-4" /> Enable
                        </>
                      )}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setRevoking(k)}>
                      <Ban className="size-4" /> Revoke
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        },
      },
    ],
    [],
  );

  return (
    <>
      {!emailVerified && <VerifyBanner email={email} />}
      <div className="mb-4 flex justify-end">
        <Button onClick={openCreate} disabled={!emailVerified}>
          <Plus className="size-4" /> Create key
        </Button>
      </div>
      {keys.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys yet"
          description="Create a key, then point any OpenAI, Anthropic or Gemini compatible client at our base URL."
          action={
            <Button onClick={openCreate} disabled={!emailVerified}>
              <Plus className="size-4" /> Create your first key
            </Button>
          }
        />
      ) : (
        <DataTable columns={columns} data={keys} searchKey="name" searchPlaceholder="Search keys..." exportFilename="api-keys" getRowId={(k) => k.id} hideColumnToggle initialSorting={[{ id: "created", desc: true }]} />
      )}

      <KeyFormDialog open={formOpen} onOpenChange={setFormOpen} editing={editing} pools={pools} currentPool={currentPool} models={models} onCreated={(k, meta) => setCreated({ ...k, ...meta })} />

      <RevealKeyDialog created={created} onClose={() => setCreated(null)} onUse={(k) => { setCreated(null); setUseKey({ name: k.name, apiKey: k.key, allowedModels: k.allowedModels }); }} />

      <UseKeyDialog open={!!useKey} onOpenChange={(o) => !o && setUseKey(null)} appUrl={appUrl} siteName={siteName} models={useKey?.allowedModels.length ? models.filter((m) => useKey.allowedModels.includes(m.slug)) : models} keyName={useKey?.name} apiKey={useKey?.apiKey} />

      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke "${revoking?.name ?? "key"}"?`}
        description="Any application using this key will immediately stop working. This can't be undone."
        confirmLabel="Revoke key"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          const r = await revokeKeyAction({ id: revoking.id });
          if (r.ok) toast.success(r.message);
          else {
            toast.error(r.error);
            throw new Error(r.error);
          }
        }}
      />
    </>
  );
}

type RevealedKey = CreatedKey & { name: string; allowedModels: string[] };

function RevealKeyDialog({ created, onClose, onUse }: { created: RevealedKey | null; onClose: () => void; onUse: (k: RevealedKey) => void }) {
  return (
    <Dialog open={!!created} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Your new API key</DialogTitle>
          <DialogDescription>Copy it now and store it somewhere safe.</DialogDescription>
        </DialogHeader>
        {created && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-2 pl-3">
              <code className="min-w-0 flex-1 break-all font-mono text-sm" data-testid="new-api-key">
                {created.key}
              </code>
              <CopyButton value={created.key} variant="secondary" size="icon" toastMessage="API key copied" />
            </div>
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
              This is the only time the full key is shown. We store only a hash, so it can&apos;t be recovered. If you lose it, create a new key.
            </p>
          </div>
        )}
        <DialogFooter>
          {created && (
            <Button variant="outline" onClick={() => onUse(created)}>
              <Terminal className="size-4" /> Use this key
            </Button>
          )}
          <Button onClick={onClose}>I&apos;ve saved it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
