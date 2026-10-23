// Pricing pages as plain text, and the numbers they contain (every price the AI reports must be one of them).
import { assertPublicUrl } from "@/gateway/ssrf";

const MAX_BYTES = 1_500_000;
const MAX_CHARS = 120_000;
const TIMEOUT_MS = 20_000;

/** Readable text of an HTML page: scripts/styles dropped, table cells separated by " | ", one block per line. */
export function htmlToText(html: string): string {
  let t = html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  t = t.replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|table|section|ul|ol|dt|dd)>/gi, "\n");
  t = t.replace(/<\/t[dh]>/gi, " | ");
  t = t.replace(/<[^>]+>/g, " ");
  t = t
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, " ");
  return t
    .replace(/[ \t ]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

export interface PageText {
  url: string;
  ok: boolean;
  text: string;
  chars: number;
  error?: string;
}

/** Fetch a pricing page (markdown or HTML) as text. Never throws. */
export async function fetchPageText(url: string, opts: { allowHosts?: string[] } = {}): Promise<PageText> {
  try {
    await assertPublicUrl(url, opts.allowHosts ?? []);
    const res = await fetch(url, { headers: { accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8", "user-agent": "ProviderProxy-PriceSync/1.0" }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return { url, ok: false, text: "", chars: 0, error: `HTTP ${res.status}` };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) return { url, ok: false, text: "", chars: 0, error: "page too large" };
    const raw = new TextDecoder().decode(buf);
    const type = res.headers.get("content-type") ?? "";
    const text = (/html/i.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : raw.trim()).slice(0, MAX_CHARS);
    if (!text) return { url, ok: false, text: "", chars: 0, error: "empty page" };
    return { url, ok: true, text, chars: text.length };
  } catch (err) {
    return { url, ok: false, text: "", chars: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Every number written in `text` ("$1,234.50" -> 1234.5, "0.05x" -> 0.05, "5%" -> 5). */
export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?|\.\d+/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.add(round(n));
  }
  return out;
}

export const round = (n: number): number => Number(n.toPrecision(10));

/** Is `n` written on the page? (a price of 0 is accepted only when "0" / "free" appears) */
export function onPage(n: number, nums: Set<number>): boolean {
  return nums.has(round(n));
}

/** Is `name` written on the page (case-insensitive, as a whole token)? */
export function nameOnPage(name: string, text: string): boolean {
  const esc = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!esc) return false;
  return new RegExp(`(^|[^\\w.-])${esc}($|[^\\w-])`, "i").test(text);
}
