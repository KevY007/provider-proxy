/** Incremental Server-Sent-Events parser + serializer (handles \n, \r\n and \r line endings). */
export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: string;
  /** Raw text of the event block (without the trailing blank line), for byte-faithful passthrough. */
  raw: string;
  /** true when the block only contained comment lines (": keepalive"). */
  comment: boolean;
}

export class SseParser {
  private buf = "";

  /** Feed decoded text; returns all complete events. */
  push(text: string): SseEvent[] {
    this.buf += text;
    const out: SseEvent[] = [];
    // normalise line endings so a single split works; keep a trailing "\r" until we know what follows
    let s = this.buf;
    let trailingCr = false;
    if (s.endsWith("\r")) {
      trailingCr = true;
      s = s.slice(0, -1);
    }
    s = s.replace(/\r\n|\r/g, "\n");
    let idx: number;
    let start = 0;
    while ((idx = s.indexOf("\n\n", start)) !== -1) {
      const block = s.slice(start, idx);
      start = idx + 2;
      const ev = parseBlock(block);
      if (ev) out.push(ev);
    }
    this.buf = s.slice(start) + (trailingCr ? "\r" : "");
    return out;
  }

  /** Flush a final unterminated block at EOF. */
  end(): SseEvent[] {
    const s = this.buf.replace(/\r\n|\r/g, "\n").trim();
    this.buf = "";
    if (!s) return [];
    const ev = parseBlock(s);
    return ev ? [ev] : [];
  }
}

function parseBlock(block: string): SseEvent | null {
  if (!block.trim()) return null;
  let event: string | undefined;
  let id: string | undefined;
  let retry: string | undefined;
  const data: string[] = [];
  let comment = true;
  for (const line of block.split("\n")) {
    if (!line) continue;
    if (line.startsWith(":")) continue;
    comment = false;
    const c = line.indexOf(":");
    const field = c === -1 ? line : line.slice(0, c);
    let value = c === -1 ? "" : line.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
    else if (field === "retry") retry = value;
  }
  return { event, data: data.join("\n"), id, retry, raw: block, comment };
}

/** Serialise an event (`event:` line optional). */
export function sseEvent(data: string | object, event?: string): string {
  const d = typeof data === "string" ? data : JSON.stringify(data);
  return (event ? `event: ${event}\n` : "") + `data: ${d}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";
