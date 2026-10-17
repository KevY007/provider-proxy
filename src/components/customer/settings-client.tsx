"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, Laptop, Loader2, LogOut, Mail, ShieldCheck, ShieldOff, Trash2, User as UserIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldGroup } from "@/components/ui/field";
import { PasswordField, SubmitButton, TextField } from "@/components/common/form-fields";
import { CopyButton } from "@/components/common/copy-button";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import {
  beginTotpSetupAction,
  changePasswordAction,
  disableTotpAction,
  enableTotpAction,
  requestEmailChangeAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
} from "@/lib/auth/actions";
import type { TotpSetup } from "@/lib/auth/totp";
import type { ActionResult } from "@/lib/auth/types";
import { deleteAccountAction, updateProfileAction } from "@/server/customer/account";
import { LocalTime } from "./local-time";

export interface SessionItem {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  current: boolean;
}

export interface SettingsClientProps {
  user: { name: string | null; email: string; emailVerified: boolean; totpEnabled: boolean; balance: string };
  sessions: SessionItem[];
}

function useForm() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult<unknown>>, onOk?: (r: Extract<ActionResult<unknown>, { ok: true }>) => void) =>
    start(async () => {
      setErrors({});
      const r = await fn();
      if (r.ok) {
        toast.success(r.message ?? "Saved");
        onOk?.(r);
      } else {
        setErrors(r.fieldErrors ?? {});
        toast.error(r.error);
      }
    });
  return { errors, pending, run };
}

function Section({ icon: Icon, title, description, children, tone }: { icon: React.ComponentType<{ className?: string }>; title: string; description?: string; children: React.ReactNode; tone?: "danger" }) {
  return (
    <Card className={tone === "danger" ? "border-red-500/30" : undefined}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Icon className={tone === "danger" ? "size-4 text-red-500" : "size-4 text-muted-foreground"} /> {title}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function SettingsClient({ user, sessions }: SettingsClientProps) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <ProfileSection name={user.name} email={user.email} verified={user.emailVerified} />
      <EmailSection />
      <PasswordSection />
      <TwoFactorSection enabled={user.totpEnabled} />
      <SessionsSection sessions={sessions} />
      <DangerSection email={user.email} balance={user.balance} />
    </div>
  );
}

function ProfileSection({ name, email, verified }: { name: string | null; email: string; verified: boolean }) {
  const [value, setValue] = useState(name ?? "");
  const f = useForm();
  const router = useRouter();
  return (
    <Section icon={UserIcon} title="Profile" description="Your name is shown in the dashboard and on receipts.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          f.run(() => updateProfileAction({ name: value }), () => router.refresh());
        }}
        className="space-y-4"
      >
        <FieldGroup className="gap-4">
          <TextField label="Name" value={value} onChange={(e) => setValue(e.target.value)} error={f.errors.name} maxLength={80} autoComplete="name" />
          <TextField label="Email" value={email} readOnly disabled description={verified ? "Verified" : "Not verified"} />
        </FieldGroup>
        <SubmitButton pending={f.pending} disabled={value === (name ?? "")}>
          Save profile
        </SubmitButton>
      </form>
    </Section>
  );
}

function EmailSection() {
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const f = useForm();
  return (
    <Section icon={Mail} title="Change email" description="We'll send a confirmation link to the new address. Your email stays the same until you confirm.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          f.run(
            () => requestEmailChangeAction({ newEmail, password }),
            () => {
              setNewEmail("");
              setPassword("");
            },
          );
        }}
        className="space-y-4"
      >
        <FieldGroup className="gap-4">
          <TextField label="New email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} error={f.errors.newEmail} autoComplete="email" required />
          <PasswordField label="Current password" value={password} onChange={(e) => setPassword(e.target.value)} error={f.errors.password} autoComplete="current-password" required />
        </FieldGroup>
        <SubmitButton pending={f.pending}>Send confirmation link</SubmitButton>
      </form>
    </Section>
  );
}

function PasswordSection() {
  const [v, setV] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const f = useForm();
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: e.target.value }));
  return (
    <Section icon={KeyRound} title="Password" description="Changing your password signs out your other devices.">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          f.run(() => changePasswordAction(v), () => setV({ currentPassword: "", newPassword: "", confirmPassword: "" }));
        }}
        className="space-y-4"
      >
        <FieldGroup className="gap-4">
          <PasswordField label="Current password" value={v.currentPassword} onChange={set("currentPassword")} error={f.errors.currentPassword} autoComplete="current-password" required />
          <PasswordField label="New password" value={v.newPassword} onChange={set("newPassword")} error={f.errors.newPassword} autoComplete="new-password" description="At least 8 characters." required />
          <PasswordField label="Confirm new password" value={v.confirmPassword} onChange={set("confirmPassword")} error={f.errors.confirmPassword} autoComplete="new-password" required />
        </FieldGroup>
        <SubmitButton pending={f.pending}>Update password</SubmitButton>
      </form>
    </Section>
  );
}

function TwoFactorSection({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [disableOpen, setDisableOpen] = useState(false);
  const [dPassword, setDPassword] = useState("");
  const [dCode, setDCode] = useState("");
  const f = useForm();
  const d = useForm();

  async function begin() {
    const r = await beginTotpSetupAction();
    if (r.ok && r.data) setSetup(r.data);
    else if (!r.ok) toast.error(r.error);
  }

  return (
    <Section icon={enabled ? ShieldCheck : ShieldOff} title="Two-factor authentication" description="Protect your account with a time-based code from an authenticator app (1Password, Authy, Google Authenticator...).">
      {enabled ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Badge className="gap-1.5 border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" variant="outline">
            <ShieldCheck className="size-3.5" /> Enabled
          </Badge>
          <Button variant="outline" onClick={() => setDisableOpen(true)}>
            Disable 2FA
          </Button>
        </div>
      ) : setup ? (
        <div className="grid gap-5 sm:grid-cols-[auto_1fr]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={setup.qrDataUrl} alt="Scan this QR code with your authenticator app" width={176} height={176} className="rounded-lg border bg-white p-2" />
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              f.run(
                () => enableTotpAction({ code }),
                () => {
                  setSetup(null);
                  setCode("");
                  router.refresh();
                },
              );
            }}
          >
            <p className="text-sm text-muted-foreground">Scan the QR code, or enter this key manually:</p>
            <div className="flex items-center gap-1 rounded-lg border bg-muted/40 py-1 pl-3 pr-1">
              <code className="min-w-0 flex-1 break-all font-mono text-xs">{setup.secret}</code>
              <CopyButton value={setup.secret} toastMessage="Secret copied" />
            </div>
            <TextField label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} error={f.errors.code} required />
            <div className="flex gap-2">
              <SubmitButton pending={f.pending} disabled={code.length !== 6}>
                Enable 2FA
              </SubmitButton>
              <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </div>
      ) : (
        <Button onClick={() => void begin()}>
          <ShieldCheck className="size-4" /> Set up 2FA
        </Button>
      )}

      <Dialog open={disableOpen} onOpenChange={setDisableOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Disable two-factor authentication</DialogTitle>
            <DialogDescription>Confirm with your password and a current code.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              d.run(
                () => disableTotpAction({ password: dPassword, code: dCode }),
                () => {
                  setDisableOpen(false);
                  setDPassword("");
                  setDCode("");
                  router.refresh();
                },
              );
            }}
          >
            <FieldGroup className="gap-4">
              <PasswordField label="Password" value={dPassword} onChange={(e) => setDPassword(e.target.value)} error={d.errors.password} required />
              <TextField label="6-digit code" inputMode="numeric" maxLength={6} value={dCode} onChange={(e) => setDCode(e.target.value.replace(/\D/g, ""))} error={d.errors.code} required />
            </FieldGroup>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDisableOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending={d.pending} disabled={dCode.length !== 6 || !dPassword}>
                Disable 2FA
              </SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl/i.test(ua) ? "curl" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function SessionsSection({ sessions }: { sessions: SessionItem[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const others = sessions.filter((s) => !s.current).length;
  async function revoke(id: string) {
    setBusyId(id);
    const r = await revokeSessionAction({ sessionId: id });
    setBusyId(null);
    if (r.ok) {
      toast.success(r.message ?? "Session revoked");
      router.refresh();
    } else toast.error(r.error);
  }
  return (
    <Section icon={Laptop} title="Active sessions" description="Devices currently signed in to your account.">
      <ul className="divide-y rounded-lg border">
        {sessions.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-3 p-3">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                {describeAgent(s.userAgent)}
                {s.current && <Badge variant="secondary">This device</Badge>}
              </p>
              <p className="text-xs text-muted-foreground">
                {s.ip ?? "unknown IP"} - signed in <LocalTime iso={s.createdAt} />
              </p>
            </div>
            {!s.current && (
              <Button variant="outline" size="sm" disabled={busyId === s.id} onClick={() => void revoke(s.id)}>
                {busyId === s.id ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />} Revoke
              </Button>
            )}
          </li>
        ))}
      </ul>
      {others > 0 && (
        <ConfirmDialog
          trigger={
            <Button variant="outline" size="sm" className="mt-3">
              Sign out all other sessions
            </Button>
          }
          title="Sign out other sessions?"
          description={`${others} other session${others === 1 ? "" : "s"} will be signed out immediately.`}
          confirmLabel="Sign out others"
          onConfirm={async () => {
            const r = await revokeOtherSessionsAction();
            if (r.ok) {
              toast.success("Other sessions signed out");
              router.refresh();
            } else {
              toast.error(r.error);
              throw new Error(r.error);
            }
          }}
        />
      )}
    </Section>
  );
}

function DangerSection({ email, balance }: { email: string; balance: string }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const f = useForm();
  const router = useRouter();
  return (
    <Section icon={Trash2} tone="danger" title="Danger zone" description="Deleting your account revokes all API keys, signs you out everywhere and anonymizes your profile. Billing records are retained as required.">
      <Button variant="destructive" onClick={() => setOpen(true)}>
        <Trash2 className="size-4" /> Delete account
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete your account?</DialogTitle>
            <DialogDescription>
              This cannot be undone.{Number(balance) > 0 ? " Any remaining balance will be forfeited." : ""} Type <span className="font-mono font-medium text-foreground">{email}</span> to confirm.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              f.run(
                () => deleteAccountAction({ email: typed }),
                (r) => {
                  const to = (r.data as { redirectTo?: string } | undefined)?.redirectTo ?? "/";
                  router.replace(to);
                  router.refresh();
                },
              );
            }}
          >
            <TextField label="Your email" value={typed} onChange={(e) => setTyped(e.target.value)} error={f.errors.email} autoComplete="off" placeholder={email} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending={f.pending} variant="destructive" disabled={typed.trim().toLowerCase() !== email.toLowerCase()}>
                Permanently delete
              </SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Section>
  );
}
