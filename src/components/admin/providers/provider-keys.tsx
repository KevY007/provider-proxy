"use client";

import { useMemo, useState } from "react";
import { FlaskConical, KeyRound, ListPlus, Loader2, MoreHorizontal, Pencil, Plus, Power, PowerOff, RotateCcw, Trash2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { EmptyState } from "@/components/common/empty-state";
import { MoneyText } from "@/components/common/money-text";
import { StatusBadge } from "@/components/common/status-badge";
import { TextField } from "@/components/common/form-fields";
import { JsonField, NumberField, SelectField, TextAreaField } from "@/components/admin/fields";
import { FormDialog, SlotBar } from "@/components/admin/misc";
import { useSlotSnapshot } from "@/components/admin/live-slots";
import { useAction } from "@/components/admin/use-action";
import {
  addProviderKey,
  bulkAddProviderKeys,
  deleteProviderKeys,
  resetProviderKey,
  rotateProviderKeySecret,
  setProviderKeysStatus,
  testAllProviderKeys,
  testProviderKey,
  updateProviderKey,
  type BulkAddResult,
} from "@/server/admin/providers-actions";
import type { ProviderKeyRow } from "@/server/admin/providers-queries";
import type { SlotSnapshot } from "@/gateway/slots";
import { formatNumber, truncate } from "@/lib/utils";

function ago(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ProviderKeys({
  providerId,
  keys,
  initialSlots,
  providerMaxConcurrency,
  canEdit,
}: {
  providerId: string;
  keys: ProviderKeyRow[];
  initialSlots: SlotSnapshot;
  providerMaxConcurrency: number | null;
  canEdit: boolean;
}) {
  const { snapshot } = useSlotSnapshot(initialSlots);
  const slotByKey = useMemo(() => new Map(snapshot.providerKeys.map((k) => [k.id, k])), [snapshot]);
  const providerSlot = snapshot.providers.find((p) => p.id === providerId);
  const totalInUse = keys.reduce((s, k) => s + (slotByKey.get(k.id)?.inUse ?? 0), 0);

  const [now] = useState(() => Date.now());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [testing, setTesting] = useState<Set<string>>(new Set());
  const { run, pending } = useAction();
  const allSelected = keys.length > 0 && keys.every((k) => selected.has(k.id));
  const ids = [...selected];
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function testOne(k: ProviderKeyRow) {
    setTesting((s) => new Set(s).add(k.id));
    const res = await run(() => testProviderKey(k.id), { success: "", toastError: true });
    setTesting((s) => {
      const n = new Set(s);
      n.delete(k.id);
      return n;
    });
    if (res.ok && res.data) {
      if (res.data.ok) toast.success(`"${k.label}" is healthy${res.data.latencyMs != null ? ` (${res.data.latencyMs}ms)` : ""}`);
      else toast.error(`"${k.label}" failed: ${res.data.error ?? "unknown error"}`);
    }
  }

  async function testAll() {
    const res = await run(() => testAllProviderKeys(providerId), { success: "" });
    if (res.ok && res.data) {
      if (res.data.total === 0) toast.info("No active keys to test");
      else if (res.data.failed === 0) toast.success(`All ${res.data.total} checks passed`);
      else toast.warning(`${res.data.ok}/${res.data.total} passed, ${res.data.failed} failed`);
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" /> Keys / accounts
          </CardTitle>
          <CardDescription>
            {keys.length} key{keys.length === 1 ? "" : "s"} · {totalInUse} slot{totalInUse === 1 ? "" : "s"} in use
            {providerMaxConcurrency ? ` (provider cap ${providerMaxConcurrency})` : ""}. Highest priority first; ties are weighted-random. Secrets are encrypted and never shown.
          </CardDescription>
          {providerSlot && providerMaxConcurrency && <SlotBar inUse={providerSlot.inUse} max={providerMaxConcurrency} className="max-w-xs" />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={testAll} disabled={pending || keys.length === 0}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />} Test all
          </Button>
          {canEdit && (
            <>
              <BulkAddDialog providerId={providerId} existingCount={keys.length} />
              <KeyDialog mode="add" providerId={providerId} />
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {canEdit && selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <span className="font-medium">{selected.size} selected</span>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setProviderKeysStatus(ids, "ACTIVE"), { onOk: () => setSelected(new Set()) })}>
              <Power className="size-4" /> Enable
            </Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => setProviderKeysStatus(ids, "DISABLED"), { onOk: () => setSelected(new Set()) })}>
              <PowerOff className="size-4" /> Disable
            </Button>
            <ConfirmDialog
              destructive
              title={`Delete ${selected.size} key${selected.size === 1 ? "" : "s"}?`}
              description="The keys are removed permanently. In-flight requests using them finish normally."
              confirmLabel="Delete"
              onConfirm={async () => {
                const r = await run(() => deleteProviderKeys(ids), { onOk: () => setSelected(new Set()) });
                if (!r.ok) throw new Error(r.error);
              }}
              trigger={
                <Button size="sm" variant="outline" className="text-red-500 hover:text-red-500">
                  <Trash2 className="size-4" /> Delete
                </Button>
              }
            />
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}
        {keys.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No keys yet"
            description="Add at least one upstream key/account so the gateway can send requests to this provider."
            action={canEdit ? <BulkAddDialog providerId={providerId} existingCount={0} /> : undefined}
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  {canEdit && (
                    <TableHead className="w-8">
                      <Checkbox
                        aria-label="Select all keys"
                        checked={allSelected}
                        onCheckedChange={(v) => setSelected(v === true ? new Set(keys.map((k) => k.id)) : new Set())}
                      />
                    </TableHead>
                  )}
                  <TableHead>Key</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Weight / prio</TableHead>
                  <TableHead className="min-w-36">Slots</TableHead>
                  <TableHead>Limits</TableHead>
                  <TableHead>Failures</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                  <TableHead className="text-right">24h</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => {
                  const slot = slotByKey.get(k.id);
                  const cooling = k.cooldownUntil && new Date(k.cooldownUntil).getTime() > now;
                  return (
                    <TableRow key={k.id} data-state={selected.has(k.id) ? "selected" : undefined}>
                      {canEdit && (
                        <TableCell>
                          <Checkbox aria-label={`Select ${k.label}`} checked={selected.has(k.id)} onCheckedChange={() => toggle(k.id)} />
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="font-medium">{k.label}</div>
                        <div className="font-mono text-xs text-muted-foreground">••••{k.secretHint}</div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={k.status} />
                        {cooling && <div className="mt-1 text-xs text-amber-500">cooldown until {new Date(k.cooldownUntil!).toLocaleTimeString()}</div>}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {k.weight} / {k.priority}
                      </TableCell>
                      <TableCell>
                        <SlotBar inUse={slot?.inUse ?? 0} max={slot?.max ?? k.maxConcurrency} compact />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        <div>rpm {k.rpmLimit ?? "∞"}{k.tpmLimit ? ` · tpm ${formatNumber(k.tpmLimit)}` : ""}</div>
                        <div>budget/day {k.dailyBudget ? <MoneyText value={k.dailyBudget} /> : "∞"}</div>
                      </TableCell>
                      <TableCell className="max-w-48">
                        <span className={k.consecutiveFailures ? "tabular-nums text-red-500" : "tabular-nums text-muted-foreground"}>{k.consecutiveFailures}</span>
                        {k.lastError && (
                          <div className="truncate text-xs text-muted-foreground" title={k.lastError}>
                            {truncate(k.lastError, 60)}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{ago(k.lastUsedAt)}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {formatNumber(k.totalRequests)} req
                        <div className="text-muted-foreground">
                          <MoneyText value={k.totalCost} />
                        </div>
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums">
                        {formatNumber(k.req24h)} req
                        <div className={k.err24h ? "text-red-500" : "text-muted-foreground"}>{formatNumber(k.err24h)} err</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          <Button size="sm" variant="outline" onClick={() => testOne(k)} disabled={testing.has(k.id)}>
                            {testing.has(k.id) ? <Loader2 className="size-3.5 animate-spin" /> : <FlaskConical className="size-3.5" />} Test
                          </Button>
                          {canEdit && (
                            <KeyMenu k={k} providerId={providerId} />
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------- row menu

function KeyMenu({ k, providerId }: { k: ProviderKeyRow; providerId: string }) {
  const { run } = useAction();
  const [edit, setEdit] = useState(false);
  const [rotate, setRotate] = useState(false);
  const [del, setDel] = useState(false);
  const disabled = k.status === "DISABLED";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${k.label}`}>
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setEdit(true)}>
            <Pencil className="size-4" /> Edit
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setRotate(true)}>
            <RefreshCw className="size-4" /> Rotate secret
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(() => resetProviderKey(k.id))}>
            <RotateCcw className="size-4" /> Reset cooldown &amp; failures
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => run(() => setProviderKeysStatus([k.id], disabled ? "ACTIVE" : "DISABLED"))}>
            {disabled ? <Power className="size-4" /> : <PowerOff className="size-4" />} {disabled ? "Enable" : "Disable"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setDel(true)}>
            <Trash2 className="size-4" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <KeyDialog mode="edit" providerId={providerId} k={k} open={edit} onOpenChange={setEdit} />
      <RotateDialog k={k} open={rotate} onOpenChange={setRotate} />
      <ConfirmDialog
        open={del}
        onOpenChange={setDel}
        destructive
        title={`Delete key "${k.label}"?`}
        description="This cannot be undone. Request logs referencing the key are kept."
        confirmLabel="Delete key"
        onConfirm={async () => {
          const r = await run(() => deleteProviderKeys([k.id]));
          if (!r.ok) throw new Error(r.error);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------- dialogs

interface KeyForm {
  label: string;
  secret: string;
  status: string;
  weight: string;
  priority: string;
  rpmLimit: string;
  tpmLimit: string;
  maxConcurrency: string;
  dailyBudget: string;
  extra: string;
}

const blankKey: KeyForm = { label: "", secret: "", status: "ACTIVE", weight: "1", priority: "0", rpmLimit: "", tpmLimit: "", maxConcurrency: "", dailyBudget: "", extra: "{}" };

function fromRow(k: ProviderKeyRow): KeyForm {
  return {
    label: k.label, secret: "", status: k.status, weight: String(k.weight), priority: String(k.priority),
    rpmLimit: k.rpmLimit?.toString() ?? "", tpmLimit: k.tpmLimit?.toString() ?? "", maxConcurrency: k.maxConcurrency?.toString() ?? "",
    dailyBudget: k.dailyBudget ?? "", extra: k.extra,
  };
}

function KeyDialog({
  mode, providerId, k, open, onOpenChange,
}: { mode: "add" | "edit"; providerId: string; k?: ProviderKeyRow; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  const [state, setState] = useState<KeyForm>(k ? fromRow(k) : blankKey);
  const { run, pending, fieldErrors, clearErrors } = useAction();
  const set = (p: Partial<KeyForm>) => setState((s) => ({ ...s, ...p }));
  const isAdd = mode === "add";
  // reset the form each time the (controlled) dialog opens - adjust state during render, not in an effect
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setState(k ? fromRow(k) : blankKey);
  }

  async function submit() {
    const base = { label: state.label, weight: state.weight, priority: state.priority, rpmLimit: state.rpmLimit, tpmLimit: state.tpmLimit, maxConcurrency: state.maxConcurrency, dailyBudget: state.dailyBudget, extra: state.extra };
    const res = isAdd
      ? await run(() => addProviderKey({ ...base, providerId, secret: state.secret }))
      : await run(() => updateProviderKey(k!.id, { ...base, status: state.status }));
    return res.ok;
  }

  return (
    <FormDialog
      wide
      open={open}
      onOpenChange={(o) => {
        onOpenChange?.(o);
        if (o) {
          setState(k ? fromRow(k) : blankKey);
          clearErrors();
        }
      }}
      trigger={
        isAdd ? (
          <Button size="sm">
            <Plus className="size-4" /> Add key
          </Button>
        ) : undefined
      }
      title={isAdd ? "Add upstream key" : `Edit "${k?.label}"`}
      description={isAdd ? "The secret is encrypted at rest and only the last 4 characters are ever displayed." : "To change the secret itself use Rotate secret."}
      submitLabel={isAdd ? "Add key" : "Save key"}
      pending={pending}
      onSubmit={submit}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField label="Label" value={state.label} onChange={(e) => set({ label: e.target.value })} error={fieldErrors.label} placeholder="team-account-1" required />
        {isAdd ? (
          <TextField label="Secret / API key" type="password" autoComplete="off" value={state.secret} onChange={(e) => set({ secret: e.target.value })} error={fieldErrors.secret} required />
        ) : (
          <SelectField
            label="Status"
            value={state.status}
            onChange={(v) => set({ status: v })}
            options={["ACTIVE", "DISABLED", "COOLDOWN", "INVALID", "EXHAUSTED"].map((s) => ({ value: s, label: s.charAt(0) + s.slice(1).toLowerCase() }))}
          />
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberField label="Weight" step="1" min={0} value={state.weight} onChange={(v) => set({ weight: v })} error={fieldErrors.weight} />
        <NumberField label="Priority" step="1" value={state.priority} onChange={(v) => set({ priority: v })} error={fieldErrors.priority} description="Higher first" />
        <NumberField label="Max concurrency" step="1" min={1} placeholder="default" value={state.maxConcurrency} onChange={(v) => set({ maxConcurrency: v })} error={fieldErrors.maxConcurrency} description="Slots" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberField label="RPM limit" step="1" min={1} placeholder="none" value={state.rpmLimit} onChange={(v) => set({ rpmLimit: v })} error={fieldErrors.rpmLimit} />
        <NumberField label="TPM limit" step="1" min={1} placeholder="none" value={state.tpmLimit} onChange={(v) => set({ tpmLimit: v })} error={fieldErrors.tpmLimit} />
        <NumberField label="Daily budget" suffix="USD" step="0.01" placeholder="none" value={state.dailyBudget} onChange={(v) => set({ dailyBudget: v })} error={fieldErrors.dailyBudget} />
      </div>
      <JsonField label="Extra (JSON)" rows={3} value={state.extra} onChange={(v) => set({ extra: v })} error={fieldErrors.extra} description="Org id, project id, Azure deployment map..." />
    </FormDialog>
  );
}

function RotateDialog({ k, open, onOpenChange }: { k: ProviderKeyRow; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [secret, setSecret] = useState("");
  const { run, pending, fieldErrors } = useAction();
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setSecret("");
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Rotate secret for "${k.label}"`}
      description={`Replaces the current secret (••••${k.secretHint}). The key is re-enabled and its failure counters are reset.`}
      submitLabel="Rotate secret"
      pending={pending}
      onSubmit={async () => (await run(() => rotateProviderKeySecret(k.id, { secret }))).ok}
    >
      <TextField label="New secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} error={fieldErrors.secret} required />
    </FormDialog>
  );
}

function BulkAddDialog({ providerId, existingCount }: { providerId: string; existingCount: number }) {
  const [text, setText] = useState("");
  const [weight, setWeight] = useState("1");
  const [priority, setPriority] = useState("0");
  const [maxConcurrency, setMaxConcurrency] = useState("");
  const [result, setResult] = useState<BulkAddResult | null>(null);
  const { run, pending, fieldErrors } = useAction();
  const lineCount = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;

  return (
    <FormDialog
      wide
      onOpenChange={(o) => {
        if (o) {
          setText("");
          setResult(null);
        }
      }}
      trigger={
        <Button size="sm" variant="outline">
          <ListPlus className="size-4" /> Bulk add
        </Button>
      }
      title="Bulk add keys"
      description={`Paste one secret per line, optionally as label|secret. Unlabelled keys are named key-${existingCount + 1}, key-${existingCount + 2}... Duplicates and blanks are skipped.`}
      submitLabel={result ? "Add more" : `Add ${lineCount || ""} key${lineCount === 1 ? "" : "s"}`.replace("  ", " ")}
      submitDisabled={lineCount === 0}
      pending={pending}
      onSubmit={async () => {
        const res = await run(() => bulkAddProviderKeys({ providerId, text, weight, priority, maxConcurrency }), { success: "" });
        if (res.ok && res.data) {
          setResult(res.data);
          toast.success(`Added ${res.data.added} key${res.data.added === 1 ? "" : "s"}${res.data.skipped.length ? `, skipped ${res.data.skipped.length}` : ""}`);
          setText("");
        }
        return false; // stay open to show the per-line summary
      }}
    >
      <TextAreaField
        label={`Keys (${lineCount} line${lineCount === 1 ? "" : "s"})`}
        value={text}
        onChange={setText}
        rows={8}
        mono
        error={fieldErrors.text}
        placeholder={"sk-proj-aaaaaaaaaaaa\nteam-b|sk-proj-bbbbbbbbbbbb"}
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberField label="Weight" step="1" min={0} value={weight} onChange={setWeight} />
        <NumberField label="Priority" step="1" value={priority} onChange={setPriority} />
        <NumberField label="Max concurrency" step="1" min={1} placeholder="default" value={maxConcurrency} onChange={setMaxConcurrency} />
      </div>
      {result && (
        <div className="rounded-lg border bg-muted/40 p-3 text-sm">
          <p className="font-medium text-emerald-500">{result.added} key{result.added === 1 ? "" : "s"} added</p>
          {result.skipped.length > 0 && (
            <>
              <p className="mt-2 font-medium text-amber-500">{result.skipped.length} line{result.skipped.length === 1 ? "" : "s"} skipped</p>
              <ul className="mt-1 max-h-32 space-y-0.5 overflow-auto text-xs text-muted-foreground">
                {result.skipped.map((s) => (
                  <li key={s.line}>
                    Line {s.line}: {s.reason}
                    {s.preview ? ` (${s.preview})` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </FormDialog>
  );
}
