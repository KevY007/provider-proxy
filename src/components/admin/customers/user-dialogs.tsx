"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2, UserPlus } from "lucide-react";
import { TextField } from "@/components/common/form-fields";
import { Button } from "@/components/ui/button";
import { SelectField, SwitchField } from "@/components/admin/fields";
import { FormDialog } from "@/components/admin/misc";
import { useAction } from "@/components/admin/use-action";
import { createCustomer, deleteCustomer, updateCustomerProfile } from "@/server/admin/customers-actions";
import { CUSTOMER_ROLES } from "@/server/admin/customers-calc";

const ROLE_LABELS: Record<(typeof CUSTOMER_ROLES)[number], string> = { CUSTOMER: "Customer", SUPPORT: "Support (staff)", ADMIN: "Admin" };

/** Customers page toolbar: create an account and (optionally) email an invite to set a password. */
export function CreateUserDialog({ groups }: { groups: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const { run, pending, fieldErrors } = useAction();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>("CUSTOMER");
  const [groupId, setGroupId] = useState("");
  const [credit, setCredit] = useState("");
  const [invite, setInvite] = useState(true);
  const reset = () => {
    setEmail("");
    setName("");
    setRole("CUSTOMER");
    setGroupId("");
    setCredit("");
    setInvite(true);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
      title="Create user"
      description="The account is active and verified right away. The user sets their own password through the invite link (valid 7 days)."
      submitLabel="Create user"
      pending={pending}
      submitDisabled={!email.includes("@")}
      trigger={
        <Button size="sm">
          <UserPlus className="size-4" /> Create user
        </Button>
      }
      onSubmit={async () => {
        const r = await run(() => createCustomer({ email, name, role, groupId: groupId || null, initialCredit: credit, sendInvite: invite }), {
          onOk: (d) => d?.id && router.push(`/admin/customers/${d.id}`),
        });
        return r.ok;
      }}
    >
      <TextField label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" error={fieldErrors.email} autoFocus />
      <TextField label="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} error={fieldErrors.name} />
      <SelectField label="Role" value={role} onChange={setRole} options={CUSTOMER_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))} error={fieldErrors.role} />
      <SelectField label="Group" value={groupId} onChange={setGroupId} allowNone noneLabel="Default group" options={groups.map((g) => ({ value: g.id, label: g.name }))} error={fieldErrors.groupId} />
      <TextField label="Starting credit (USD, optional)" value={credit} onChange={(e) => setCredit(e.target.value)} placeholder="e.g. 10" inputMode="decimal" error={fieldErrors.initialCredit} />
      <SwitchField label="Email an invite" checked={invite} onChange={setInvite} description="Sends a link to choose a password. Without it, use Password reset on their page later." />
    </FormDialog>
  );
}

/** Customer detail header: edit name and email. */
export function EditProfileDialog({ userId, email, name }: { userId: string; email: string; name: string | null }) {
  const { run, pending, fieldErrors } = useAction();
  const [open, setOpen] = useState(false);
  const [e, setE] = useState(email);
  const [n, setN] = useState(name ?? "");
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setE(email);
          setN(name ?? "");
        }
      }}
      title="Edit profile"
      description="A new email set here counts as verified; pending verification and reset links are cancelled."
      pending={pending}
      submitDisabled={!e.includes("@")}
      trigger={
        <Button variant="outline" size="sm">
          <Pencil className="size-4" /> Edit
        </Button>
      }
      onSubmit={async () => (await run(() => updateCustomerProfile({ userId, email: e, name: n }))).ok}
    >
      <TextField label="Email" type="email" value={e} onChange={(ev) => setE(ev.target.value)} error={fieldErrors.email} autoFocus />
      <TextField label="Name" value={n} onChange={(ev) => setN(ev.target.value)} error={fieldErrors.name} />
    </FormDialog>
  );
}

/** Customer detail header: delete (or anonymise, when the account has billing history). Requires typing the email. */
export function DeleteUserDialog({ userId, email, disabled }: { userId: string; email: string; disabled?: boolean }) {
  const { run, pending } = useAction();
  const [typed, setTyped] = useState("");
  return (
    <FormDialog
      destructive
      title={`Delete ${email}?`}
      description="Signs them out and removes the account. If it has payments or ledger entries, those are kept for accounting and the account is anonymised and locked instead. This cannot be undone."
      submitLabel="Delete user"
      pending={pending}
      submitDisabled={typed.trim().toLowerCase() !== email.toLowerCase()}
      onOpenChange={(o) => !o && setTyped("")}
      trigger={
        <Button variant="outline" size="sm" disabled={disabled} className="text-destructive">
          <Trash2 className="size-4" /> Delete
        </Button>
      }
      onSubmit={async () => {
        const r = await run(() => deleteCustomer(userId), { refresh: false, onOk: (d) => window.location.assign(d?.redirectTo ?? "/admin/customers") });
        return r.ok;
      }}
    >
      <TextField label={`Type ${email} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
    </FormDialog>
  );
}
