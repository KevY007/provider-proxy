/**
 * Pure parser for the "bulk add upstream keys" textarea (no server-only imports, unit tested).
 *
 * One entry per line, either `secret` or `label|secret`. Blank lines and `#` comment lines are skipped,
 * whitespace trimmed, duplicate secrets (within the paste or already present) skipped. Entries without a
 * label are auto-labelled `key-N`, continuing from `startIndex` (existing key count) and skipping labels
 * that already exist.
 */
export interface ParsedBulkKey {
  line: number;
  label: string;
  secret: string;
}

export interface BulkSkipped {
  line: number;
  reason: string;
  preview: string;
}

export interface BulkParseResult {
  entries: ParsedBulkKey[];
  skipped: BulkSkipped[];
}

export const MAX_BULK_KEYS = 500;

function preview(s: string): string {
  const t = s.trim();
  return t.length <= 8 ? "****" : `${t.slice(0, 3)}...${t.slice(-4)}`;
}

export function parseBulkKeys(
  text: string,
  opts: { startIndex?: number; existingLabels?: Iterable<string>; existingSecrets?: Iterable<string> } = {},
): BulkParseResult {
  const entries: ParsedBulkKey[] = [];
  const skipped: BulkSkipped[] = [];
  const seenSecrets = new Set<string>(opts.existingSecrets ?? []);
  const usedLabels = new Set<string>(opts.existingLabels ?? []);
  let counter = (opts.startIndex ?? 0) + 1;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    let label = "";
    let secret = raw;
    const bar = raw.indexOf("|");
    if (bar >= 0) {
      label = raw.slice(0, bar).trim();
      secret = raw.slice(bar + 1).trim();
    }
    if (!secret) {
      skipped.push({ line: i + 1, reason: "Empty secret", preview: "" });
      continue;
    }
    if (secret.length < 8) {
      skipped.push({ line: i + 1, reason: "Secret too short (min 8 chars)", preview: preview(secret) });
      continue;
    }
    if (seenSecrets.has(secret)) {
      skipped.push({ line: i + 1, reason: "Duplicate secret", preview: preview(secret) });
      continue;
    }
    if (entries.length >= MAX_BULK_KEYS) {
      skipped.push({ line: i + 1, reason: `Over the ${MAX_BULK_KEYS} keys per batch limit`, preview: preview(secret) });
      continue;
    }
    seenSecrets.add(secret);
    if (!label) {
      while (usedLabels.has(`key-${counter}`)) counter++;
      label = `key-${counter}`;
      counter++;
    }
    label = label.slice(0, 80);
    usedLabels.add(label);
    entries.push({ line: i + 1, label, secret });
  }
  return { entries, skipped };
}
