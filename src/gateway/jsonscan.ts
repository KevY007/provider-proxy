import type { Segment } from "./spool";

/**
 * Byte-level view of a JSON request body: where every TOP-LEVEL member sits. Lets the gateway forward the client's
 * bytes unchanged and only replace / insert the few members it must change (e.g. `model`), instead of
 * re-serialising the whole document (PLAN 5c: "forwarded byte-identical when unmodified"). Strings are skipped with
 * `indexOf` jumps, so even a 200 MB document with a giant base64 value is scanned in well under a second.
 */
export interface TopLevelMember {
  key: string;
  /** index of the opening quote of the key */
  keyStart: number;
  valueStart: number;
  /** exclusive */
  valueEnd: number;
}

export interface TopLevelScan {
  members: TopLevelMember[];
  byKey: Map<string, TopLevelMember[]>;
  /** index of the opening `{` */
  open: number;
  /** index of the closing `}` */
  close: number;
}

const WS = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

function skipWs(b: Buffer, i: number): number {
  while (i < b.length && WS(b[i])) i++;
  return i;
}

/** `i` is the index of the opening quote; returns the index AFTER the closing quote, or -1. */
function skipString(b: Buffer, i: number): number {
  let j = i + 1;
  for (;;) {
    j = b.indexOf(0x22, j);
    if (j < 0) return -1;
    let k = j - 1;
    let bs = 0;
    while (k > i && b[k] === 0x5c) {
      bs++;
      k--;
    }
    if (bs % 2 === 0) return j + 1;
    j++;
  }
}

/** End (exclusive) of the JSON value starting at `i`, or -1 when malformed. */
function skipValue(b: Buffer, i: number): number {
  const c = b[i];
  if (c === 0x22) return skipString(b, i);
  if (c === 0x7b || c === 0x5b) {
    let depth = 0;
    let j = i;
    while (j < b.length) {
      const ch = b[j];
      if (ch === 0x22) {
        j = skipString(b, j);
        if (j < 0) return -1;
        continue;
      }
      if (ch === 0x7b || ch === 0x5b) depth++;
      else if (ch === 0x7d || ch === 0x5d) {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    return -1;
  }
  // number / true / false / null
  let j = i;
  while (j < b.length && b[j] !== 0x2c && b[j] !== 0x7d && b[j] !== 0x5d && !WS(b[j])) j++;
  return j > i ? j : -1;
}

/** Scan the top level of a JSON object document. Returns null when the body is not a (well-formed) JSON object. */
export function scanTopLevel(b: Buffer): TopLevelScan | null {
  let i = skipWs(b, 0);
  if (b[i] !== 0x7b) return null;
  const open = i;
  i = skipWs(b, i + 1);
  const members: TopLevelMember[] = [];
  const byKey = new Map<string, TopLevelMember[]>();
  if (b[i] === 0x7d) return { members, byKey, open, close: i };
  for (;;) {
    if (b[i] !== 0x22) return null;
    const keyStart = i;
    const keyEnd = skipString(b, i);
    if (keyEnd < 0) return null;
    const raw = b.toString("utf8", keyStart + 1, keyEnd - 1);
    let key = raw;
    if (raw.includes("\\")) {
      try {
        key = JSON.parse(b.toString("utf8", keyStart, keyEnd)) as string;
      } catch {
        return null;
      }
    }
    i = skipWs(b, keyEnd);
    if (b[i] !== 0x3a) return null;
    i = skipWs(b, i + 1);
    const valueStart = i;
    const valueEnd = skipValue(b, i);
    if (valueEnd < 0) return null;
    const m: TopLevelMember = { key, keyStart, valueStart, valueEnd };
    members.push(m);
    const list = byKey.get(key);
    if (list) list.push(m);
    else byKey.set(key, [m]);
    i = skipWs(b, valueEnd);
    if (b[i] === 0x2c) {
      i = skipWs(b, i + 1);
      continue;
    }
    if (b[i] === 0x7d) return { members, byKey, open, close: i };
    return null;
  }
}

const MAX_SPLICE_VALUE = 256 * 1024;

/**
 * Build the segments of `original` that carry the intended `changes` (top-level key -> new value, `undefined` = the key
 * is unchanged). Returns null when the change cannot be expressed as replacing / inserting members (a duplicate key,
 * a deletion, a huge replacement value) - the caller then re-serialises.
 *
 *  - key present once  -> its value bytes are replaced,
 *  - key absent        -> `"key":value,` is inserted right after the opening brace.
 */
export function spliceTopLevel(scan: TopLevelScan, size: number, changes: Record<string, unknown>): Segment[] | null {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let inserts = "";
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) return null; // deletion
    const text = JSON.stringify(value);
    if (text === undefined || text.length > MAX_SPLICE_VALUE) return null;
    const have = scan.byKey.get(key);
    if (!have) {
      inserts += `${JSON.stringify(key)}:${text},`;
      continue;
    }
    if (have.length !== 1) return null;
    edits.push({ start: have[0].valueStart, end: have[0].valueEnd, text });
  }
  if (inserts) {
    // the opening brace is followed by at least one member iff there are members; keep the document valid either way
    const trimmed = scan.members.length ? inserts : inserts.slice(0, -1);
    edits.push({ start: scan.open + 1, end: scan.open + 1, text: trimmed });
  }
  edits.sort((a, b) => a.start - b.start);
  const segs: Segment[] = [];
  let pos = 0;
  for (const e of edits) {
    if (e.start < pos) return null;
    if (e.start > pos) segs.push({ start: pos, end: e.start });
    if (e.text) segs.push(e.text);
    pos = e.end;
  }
  if (pos < size) segs.push({ start: pos, end: size });
  return segs;
}
