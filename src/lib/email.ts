import nodemailer, { type Transporter } from "nodemailer";
import { db } from "./db";
import { env, appUrl } from "./env";
import { logger } from "./logger";
import { getSettings } from "./settings";
import { formatUSD, type MoneyLike } from "./money";

/**
 * Email. With SMTP_URL set, mail goes out via nodemailer. Without it, the message is logged to the
 * console AND stored in the EmailOutbox table (so devs/tests can read verification links).
 * `sendEmail` never throws; it returns `{ ok, id? }`.
 */
export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
}

let transporter: Transporter | null | undefined;
function getTransporter(): Transporter | null {
  if (transporter !== undefined) return transporter;
  transporter = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;
  return transporter;
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<\/(p|div|h\d|tr|li)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function sendEmail(input: SendEmailInput): Promise<{ ok: boolean; id?: string; error?: string }> {
  const t = getTransporter();
  if (!t) {
    try {
      const row = await db.emailOutbox.create({
        data: { to: input.to, subject: input.subject, html: input.html },
      });
      logger.info("email (no SMTP configured; stored in EmailOutbox)", {
        to: input.to,
        subject: input.subject,
        outboxId: row.id,
        preview: htmlToText(input.html).slice(0, 600),
        links: [...input.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]),
      });
      return { ok: true, id: row.id };
    } catch (err) {
      logger.error("failed to store email in outbox", { err });
      return { ok: false, error: "outbox_failed" };
    }
  }
  try {
    const settings = await getSettings();
    await t.sendMail({
      from: env.EMAIL_FROM,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text ?? htmlToText(input.html),
      replyTo: input.replyTo ?? (settings.supportEmail || undefined),
    });
    return { ok: true };
  } catch (err) {
    logger.error("smtp send failed", { to: input.to, subject: input.subject, err });
    try {
      await db.emailOutbox.create({
        data: {
          to: input.to,
          subject: input.subject,
          html: input.html,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } catch {
      /* ignore */
    }
    return { ok: false, error: "smtp_failed" };
  }
}

// --------------------------------------------------------------------------------------------
// Templates
// --------------------------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

interface Layout {
  siteName: string;
  preheader?: string;
  title: string;
  body: string;
  cta?: { label: string; url: string };
  footer?: string;
}

function layout({ siteName, preheader, title, body, cta, footer }: Layout): string {
  const button = cta
    ? `<p style="margin:28px 0"><a href="${escapeHtml(cta.url)}" style="background:#10b981;color:#04130d;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;display:inline-block">${escapeHtml(cta.label)}</a></p>
       <p style="font-size:12px;color:#6b7280;word-break:break-all">Or copy this link: <a href="${escapeHtml(cta.url)}" style="color:#059669">${escapeHtml(cta.url)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>` : ""}
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 12px">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e5e7eb">
<tr><td style="padding:24px 32px;border-bottom:1px solid #e5e7eb;font-weight:700;font-size:18px;color:#059669">${escapeHtml(siteName)}</td></tr>
<tr><td style="padding:32px;font-size:15px;line-height:1.6">
<h1 style="margin:0 0 16px;font-size:20px">${escapeHtml(title)}</h1>
${body}
${button}
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280">${footer ?? `You received this email because of activity on your ${escapeHtml(siteName)} account.`}</td></tr>
</table></td></tr></table></body></html>`;
}

export interface TemplateResult {
  subject: string;
  html: string;
}

const hello = (name?: string | null) => `<p>Hi${name ? ` ${escapeHtml(name)}` : ""},</p>`;

export const emailTemplates = {
  async verifyEmail(p: { name?: string | null; url: string }): Promise<TemplateResult> {
    const { siteName } = await getSettings();
    return {
      subject: `Verify your email for ${siteName}`,
      html: layout({
        siteName,
        title: "Verify your email address",
        preheader: "Confirm your email to activate your account.",
        body: `${hello(p.name)}<p>Welcome to ${escapeHtml(siteName)}! Please confirm your email address to activate your account. This link expires in 24 hours.</p>`,
        cta: { label: "Verify email", url: p.url },
      }),
    };
  },

  async resetPassword(p: { name?: string | null; url: string }): Promise<TemplateResult> {
    const { siteName } = await getSettings();
    return {
      subject: `Reset your ${siteName} password`,
      html: layout({
        siteName,
        title: "Reset your password",
        body: `${hello(p.name)}<p>We received a request to reset your password. This link expires in 1 hour. If you didn't request this, you can safely ignore this email - your password won't change.</p>`,
        cta: { label: "Choose a new password", url: p.url },
      }),
    };
  },

  async emailChange(p: { name?: string | null; url: string; newEmail: string }): Promise<TemplateResult> {
    const { siteName } = await getSettings();
    return {
      subject: `Confirm your new email for ${siteName}`,
      html: layout({
        siteName,
        title: "Confirm your new email address",
        body: `${hello(p.name)}<p>Confirm that <strong>${escapeHtml(p.newEmail)}</strong> should be the email for your ${escapeHtml(siteName)} account. This link expires in 24 hours.</p>`,
        cta: { label: "Confirm email change", url: p.url },
      }),
    };
  },

  /** Sent to the OLD address when someone asks to move the account to a new one. */
  async emailChangeNotice(p: { name?: string | null; newEmail: string }): Promise<TemplateResult> {
    const { siteName } = await getSettings();
    return {
      subject: `Your ${siteName} email address is being changed`,
      html: layout({
        siteName,
        title: "Email change requested",
        body: `${hello(p.name)}<p>Someone signed in to your ${escapeHtml(siteName)} account asked to change its email address to <strong>${escapeHtml(p.newEmail)}</strong>. If this was you, nothing else is needed. If it was not, change your password right away and contact support.</p>`,
        cta: { label: "Review account security", url: `${appUrl}/dashboard/settings` },
      }),
    };
  },

  async lowBalance(p: { name?: string | null; balance: MoneyLike; topUpUrl?: string }): Promise<TemplateResult> {
    const { siteName } = await getSettings();
    return {
      subject: `Your ${siteName} balance is running low`,
      html: layout({
        siteName,
        title: "Low balance",
        body: `${hello(p.name)}<p>Your current balance is <strong>${formatUSD(p.balance)}</strong>. API requests will be rejected when your balance runs out. Add credit to avoid interruptions, or turn on auto-recharge.</p>`,
        cta: { label: "Add credit", url: p.topUpUrl ?? `${appUrl}/dashboard/billing` },
      }),
    };
  },

  async paymentFailed(p: { name?: string | null; amount: MoneyLike; reason?: string | null }): Promise<TemplateResult> {
    const { siteName } = await getSettings();
    return {
      subject: `Payment failed on ${siteName}`,
      html: layout({
        siteName,
        title: "We couldn't process your payment",
        body: `${hello(p.name)}<p>A payment of <strong>${formatUSD(p.amount)}</strong> failed${p.reason ? `: ${escapeHtml(p.reason)}` : ""}. Please check your payment method.</p>`,
        cta: { label: "Update payment method", url: `${appUrl}/dashboard/billing` },
      }),
    };
  },

  async autoRechargeDisabled(p: { name?: string | null; reason?: string | null }): Promise<TemplateResult> {
    const { siteName } = await getSettings();
    return {
      subject: `Auto-recharge was turned off on ${siteName}`,
      html: layout({
        siteName,
        title: "Auto-recharge disabled",
        body: `${hello(p.name)}<p>We turned off auto-recharge on your account after repeated payment failures${p.reason ? ` (${escapeHtml(p.reason)})` : ""}. Update your payment method and re-enable it from the billing page.</p>`,
        cta: { label: "Open billing", url: `${appUrl}/dashboard/billing` },
      }),
    };
  },

  async welcome(p: { name?: string | null }): Promise<TemplateResult> {
    const { siteName } = await getSettings();
    return {
      subject: `Welcome to ${siteName}`,
      html: layout({
        siteName,
        title: "You're all set",
        body: `${hello(p.name)}<p>Your account is active. Create an API key, point your SDK at our base URL, and start sending requests - OpenAI, Anthropic and Gemini formats are all supported.</p>`,
        cta: { label: "Create your first API key", url: `${appUrl}/dashboard/keys` },
      }),
    };
  },

  async accountExists(p: { name?: string | null }): Promise<TemplateResult> {
    const { siteName } = await getSettings();
    return {
      subject: `Someone tried to sign up with your email on ${siteName}`,
      html: layout({
        siteName,
        title: "You already have an account",
        body: `${hello(p.name)}<p>Someone tried to create a ${escapeHtml(siteName)} account with this email address, but you already have one. If it was you, just log in - or reset your password if you've forgotten it.</p>`,
        cta: { label: "Log in", url: `${appUrl}/login` },
      }),
    };
  },
};

/** Render a template and send it. */
export async function sendTemplate(to: string, tpl: Promise<TemplateResult> | TemplateResult) {
  const t = await tpl;
  return sendEmail({ to, subject: t.subject, html: t.html });
}
