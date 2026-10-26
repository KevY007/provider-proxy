"use client";

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Ban, Eye, KeyRound, MoreHorizontal, Pencil, Plus, Power, PowerOff, Terminal, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { CopyButton } from "@/components/common/copy-button";
import { DataTable } from "@/components/common/data-table";
import { EmptyState } from "@/components/common/empty-state";
import { MoneyText } from "@/components/common/money-text";
import { StatusBadge } from "@/components/common/status-badge";
import { formatCompact } from "@/lib/utils";
import { deleteRevokedKeyAction, emptyRevokedKeysAction, revealOwnKeyAction, revokeKeyAction, setKeyEnabledAction, type CreatedKey } from "@/server/customer/keys";
import { poolSavingsLabel } from "@/server/customer/pricing";
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
  const [created, setCreated] = useState<RevealedKey | null>(null);
  const [useKey, setUseKey] = useState<UseKeyTarget | null>(null);
  const [revoking, setRevoking] = useState<KeyRow | null>(null);
  const [deleting, setDeleting] = useState<KeyRow | null>(null);
  const [emptying, setEmptying] = useState(false);
  // revoked keys no longer work: they live in their own "Revoked" tab instead of cluttering the list
  const activeKeys = useMemo(() => keys.filter((k) => k.status !== "REVOKED"), [keys]);
  const revokedKeys = useMemo(() => keys.filter((k) => k.status === "REVOKED"), [keys]);

  async function reveal(k: KeyRow) {
    const r = await revealOwnKeyAction({ id: k.id });
    if (!r.ok || !r.data) {
      toast.error(r.ok ? "Could not show the key" : r.error);
      return;
    }
    setCreated({ id: k.id, key: r.data.key, prefix: k.prefix, name: k.name, allowedModels: k.allowedModels, groupId: k.groupId, existing: true });
  }

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
        accessorFn: (k) => (k.groupName ? `${k.groupName} ${poolSavingsLabel(k.groupSavingsPct)}`.trim() : "Account default"),
        cell: ({ row }) =>
          row.original.groupName ? (
            <span className="whitespace-nowrap">
              {row.original.groupName} {poolSavingsLabel(row.original.groupSavingsPct) && <span className="text-muted-foreground">{poolSavingsLabel(row.original.groupSavingsPct)}</span>}
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
        id: "listPrice",
        header: () => (
          <Tooltip>
            <TooltipTrigger asChild><span className="cursor-help underline decoration-dotted underline-offset-4">At list price</span></TooltipTrigger>
            <TooltipContent className="max-w-xs">What this key&apos;s requests would have cost at the providers&apos; official prices.</TooltipContent>
          </Tooltip>
        ),
        accessorFn: (k) => Number(k.listPrice ?? 0),
        cell: ({ row }) => {
          const k = row.original;
          if (!k.listPrice || Number(k.listPrice) <= 0) return <span className="text-muted-foreground">-</span>;
          return <MoneyText value={k.listPrice} className="whitespace-nowrap text-sm text-muted-foreground" />;
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
        meta: { noExport: true, className: "w-20" },
        cell: ({ row }) => {
          const k = row.original;
          const revoked = k.status === "REVOKED";
          return (
            <div className="flex items-center justify-end gap-0.5">
            {!revoked && (
              <Button variant="ghost" size="icon" className="size-8" aria-label={`Use ${k.name}`} title="Use key: setup steps for Claude Code, Codex, IDEs and SDKs" onClick={() => setUseKey({ id: k.id, name: k.name, apiKey: null, allowedModels: k.allowedModels, groupId: k.groupId })}>
                <Terminal className="size-4" />
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${k.name}`}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setUseKey({ id: k.id, name: k.name, apiKey: null, allowedModels: k.allowedModels, groupId: k.groupId })}>
                  <Terminal className="size-4" /> Use key
                </DropdownMenuItem>
                {!revoked && (
                  <>
                    <DropdownMenuItem onSelect={() => void reveal(k)}>
                      <Eye className="size-4" /> Reveal key
                    </DropdownMenuItem>
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
            </div>
          );
        },
      },
    ],
    [],
  );

  const revokedColumns = useMemo<ColumnDef<KeyRow>[]>(
    () => [
      ...columns.filter((c) => ["name", "pool", "spent", "listPrice", "lastUsed", "created"].includes((c.id ?? (c as { accessorKey?: string }).accessorKey) as string)),
      {
        id: "delete",
        header: "",
        enableSorting: false,
        enableHiding: false,
        meta: { noExport: true, className: "w-10" },
        cell: ({ row }) => (
          <Button variant="ghost" size="sm" className="text-red-500 hover:text-red-500" onClick={() => setDeleting(row.original)} aria-label={`Delete ${row.original.name}`}>
            <Trash2 className="size-4" /> Delete
          </Button>
        ),
      },
    ],
    [columns],
  );

  return (
    <>
      {!emailVerified && <VerifyBanner email={email} />}
      <div className="mb-4 flex justify-end">
        <Button onClick={openCreate} disabled={!emailVerified}>
          <Plus className="size-4" /> Create key
        </Button>
      </div>
      <Tabs defaultValue="active">
        <TabsList>
          <TabsTrigger value="active">Active ({activeKeys.length})</TabsTrigger>
          <TabsTrigger value="revoked">Revoked ({revokedKeys.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="active" className="mt-4">
          {activeKeys.length === 0 ? (
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
            <DataTable columns={columns} data={activeKeys} searchKey="name" searchPlaceholder="Search keys..." exportFilename="api-keys" getRowId={(k) => k.id} hideColumnToggle initialSorting={[{ id: "created", desc: true }]} />
          )}
        </TabsContent>
        <TabsContent value="revoked" className="mt-4 space-y-3">
          {revokedKeys.length === 0 ? (
            <EmptyState icon={Trash2} title="No revoked keys" description="Keys you revoke show up here until you delete them." />
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">Revoked keys no longer work. Delete them to clear them out for good; their usage history stays in your logs.</p>
                <Button variant="outline" size="sm" className="shrink-0 text-red-500 hover:text-red-500" onClick={() => setEmptying(true)}>
                  <Trash2 className="size-4" /> Empty bin
                </Button>
              </div>
              <DataTable columns={revokedColumns} data={revokedKeys} searchKey="name" searchPlaceholder="Search revoked keys..." exportFilename="revoked-api-keys" getRowId={(k) => k.id} hideColumnToggle initialSorting={[{ id: "created", desc: true }]} />
            </>
          )}
        </TabsContent>
      </Tabs>

      <KeyFormDialog open={formOpen} onOpenChange={setFormOpen} editing={editing} pools={pools} currentPool={currentPool} models={models} onCreated={(k, meta) => setCreated({ ...k, ...meta })} />

      <RevealKeyDialog created={created} onClose={() => setCreated(null)} onUse={(k) => { setCreated(null); setUseKey({ id: k.id, name: k.name, apiKey: k.key, allowedModels: k.allowedModels, groupId: k.groupId }); }} />

      <UseKeyDialog open={!!useKey} onOpenChange={(o) => !o && setUseKey(null)} appUrl={appUrl} siteName={siteName} models={useKey ? keyModels(useKey, pools, currentPool, models) : []} poolName={useKey ? (pools.find((p) => p.id === useKey.groupId) ?? currentPool)?.name : null} keyId={useKey?.id} keyName={useKey?.name} apiKey={useKey?.apiKey} />

      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete "${deleting?.name ?? "key"}" permanently?`}
        description="The revoked key is removed for good. Its usage history stays in your logs."
        confirmLabel="Delete key"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const r = await deleteRevokedKeyAction({ id: deleting.id });
          if (r.ok) toast.success(r.message);
          else {
            toast.error(r.error);
            throw new Error(r.error);
          }
        }}
      />

      <ConfirmDialog
        open={emptying}
        onOpenChange={setEmptying}
        title={`Delete all ${revokedKeys.length} revoked key${revokedKeys.length === 1 ? "" : "s"}?`}
        description="They are removed for good. Their usage history stays in your logs."
        confirmLabel="Delete all"
        destructive
        onConfirm={async () => {
          const r = await emptyRevokedKeysAction();
          if (r.ok) toast.success(r.message);
          else {
            toast.error(r.error);
            throw new Error(r.error);
          }
        }}
      />

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

/** `existing`: a key revealed again from its menu (not just created). */
type RevealedKey = CreatedKey & { name: string; allowedModels: string[]; groupId: string | null; existing?: boolean };

interface UseKeyTarget {
  id: string;
  name: string;
  apiKey: string | null;
  allowedModels: string[];
  groupId: string | null;
}

/** The models a key can call: its pool's models (empty list = all), narrowed by the key's own model list. */
function keyModels(k: UseKeyTarget, pools: PoolOption[], currentPool: PoolOption | null, models: ModelOption[]): ModelOption[] {
  const pool = pools.find((p) => p.id === k.groupId) ?? currentPool;
  return models.filter((m) => (!pool?.allowedModels.length || pool.allowedModels.includes(m.slug)) && (!k.allowedModels.length || k.allowedModels.includes(m.slug)));
}

function RevealKeyDialog({ created, onClose, onUse }: { created: RevealedKey | null; onClose: () => void; onUse: (k: RevealedKey) => void }) {
  return (
    <Dialog open={!!created} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{created?.existing ? `API key "${created.name}"` : "Your new API key"}</DialogTitle>
          <DialogDescription>Copy it and store it somewhere safe.</DialogDescription>
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
              Keep it secret: anyone with this key can spend your balance. You can view it again from the key&apos;s menu; if it leaks, revoke it and create a new one.
            </p>
          </div>
        )}
        <DialogFooter>
          {created && (
            <Button variant="outline" onClick={() => onUse(created)}>
              <Terminal className="size-4" /> Use this key
            </Button>
          )}
          <Button onClick={onClose}>{created?.existing ? "Done" : "I've saved it"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
