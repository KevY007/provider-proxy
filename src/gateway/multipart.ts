import { BodySpool, type Segment, type SpoolOptions } from "./spool";

/**
 * Streaming multipart/form-data support (PLAN 5c). The customer's upload is spooled (memory for small bodies, a temp
 * file for large ones) while a streaming scanner records where every part sits and reads the small TEXT fields; file
 * parts are never held in memory or parsed. The body is then forwarded byte-identical - same boundary, same part
 * order - except for the `model` field, which is replaced (or appended) by slicing the spool.
 */
export interface FormField {
  name: string;
  value: string;
  /** byte range of the value inside the spool */
  start: number;
  end: number;
}
export interface FormFile {
  name: string;
  filename: string;
  type: string;
  size: number;
  /** byte range of the file content inside the spool */
  start: number;
  end: number;
}
export interface ParsedForm {
  fields: FormField[];
  files: FormFile[];
  /** original part order (for faithful re-encoding) */
  order: Array<{ kind: "field" | "file"; index: number }>;
  spool: BodySpool;
  /** the customer's Content-Type, boundary included: reused for the upstream request */
  contentType: string;
  boundary: string;
  /** offset of the closing `--boundary--` delimiter */
  closeStart: number;
}

export class MultipartError extends Error {
  constructor(message = "Could not parse the multipart form body.") {
    super(message);
    this.name = "MultipartError";
  }
}

const MAX_FIELD_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

export function boundaryOf(contentType: string): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m ? (m[1] ?? m[2]) : null;
}

interface PartState {
  name: string;
  filename: string | null;
  type: string;
  contentStart: number;
  size: number;
  chunks: Buffer[];
  truncated: boolean;
}

type ScanState = "preamble" | "delim_tail" | "headers" | "content" | "done";

/** Incremental scanner: feed chunks with `push`, then `finish()`. Memory = O(boundary + part headers + text fields). */
export class MultipartScanner {
  readonly fields: FormField[] = [];
  readonly files: FormFile[] = [];
  readonly order: Array<{ kind: "field" | "file"; index: number }> = [];
  closeStart = -1;

  private buf: Buffer = Buffer.alloc(0);
  private base = 0;
  private state: ScanState = "preamble";
  private readonly first: Buffer;
  private readonly delim: Buffer;
  private delimStart = 0;
  private part: PartState | null = null;

  constructor(boundary: string) {
    this.first = Buffer.from(`--${boundary}`);
    this.delim = Buffer.from(`\r\n--${boundary}`);
  }

  private consume(n: number): void {
    this.buf = this.buf.subarray(n);
    this.base += n;
  }

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    this.run();
  }

  private content(data: Buffer): void {
    const p = this.part!;
    p.size += data.length;
    if (p.filename === null && !p.truncated) {
      if (p.size > MAX_FIELD_BYTES) {
        p.truncated = true;
        p.chunks = [];
      } else p.chunks.push(Buffer.from(data));
    }
  }

  private endPart(contentEnd: number): void {
    const p = this.part!;
    this.part = null;
    if (p.filename !== null) {
      this.order.push({ kind: "file", index: this.files.length });
      this.files.push({ name: p.name, filename: p.filename, type: p.type, size: p.size, start: p.contentStart, end: contentEnd });
    } else {
      this.order.push({ kind: "field", index: this.fields.length });
      this.fields.push({ name: p.name, value: p.truncated ? "" : Buffer.concat(p.chunks).toString("utf8"), start: p.contentStart, end: contentEnd });
    }
  }

  private run(): void {
    for (;;) {
      switch (this.state) {
        case "preamble": {
          const i = this.buf.indexOf(this.first);
          if (i < 0) {
            const keep = this.first.length - 1;
            if (this.buf.length > keep) this.consume(this.buf.length - keep);
            return;
          }
          this.delimStart = this.base + i;
          this.consume(i + this.first.length);
          this.state = "delim_tail";
          break;
        }
        case "delim_tail": {
          if (this.buf.length < 2) return;
          if (this.buf[0] === 0x2d && this.buf[1] === 0x2d) {
            this.closeStart = this.delimStart;
            this.state = "done";
            return;
          }
          const i = this.buf.indexOf("\r\n");
          if (i < 0) {
            if (this.buf.length > 1024) throw new MultipartError();
            return;
          }
          this.consume(i + 2);
          this.state = "headers";
          break;
        }
        case "headers": {
          const i = this.buf.indexOf("\r\n\r\n");
          if (i < 0) {
            if (this.buf.length > MAX_HEADER_BYTES) throw new MultipartError();
            return;
          }
          const head = this.buf.toString("utf8", 0, i);
          const name = /name="((?:[^"\\]|\\.)*)"/i.exec(head)?.[1];
          if (name === undefined) throw new MultipartError();
          const filename = /filename="((?:[^"\\]|\\.)*)"/i.exec(head)?.[1] ?? (/filename=([^;\r\n]+)/i.exec(head)?.[1] ?? null);
          const type = /^content-type:\s*([^\r\n]+)/im.exec(head)?.[1]?.trim() ?? "";
          this.part = { name, filename, type, contentStart: this.base + i + 4, size: 0, chunks: [], truncated: false };
          this.consume(i + 4);
          this.state = "content";
          break;
        }
        case "content": {
          const i = this.buf.indexOf(this.delim);
          if (i >= 0) {
            this.content(this.buf.subarray(0, i));
            this.endPart(this.base + i);
            this.delimStart = this.base + i + 2;
            this.consume(i + this.delim.length);
            this.state = "delim_tail";
            break;
          }
          const keep = this.delim.length - 1;
          if (this.buf.length > keep) {
            this.content(this.buf.subarray(0, this.buf.length - keep));
            this.consume(this.buf.length - keep);
          }
          return;
        }
        case "done":
          this.buf = Buffer.alloc(0);
          return;
      }
    }
  }

  get complete(): boolean {
    return this.state === "done";
  }
}

/** Spool + scan a multipart upload in one streaming pass. Throws MultipartError for a malformed body. */
export async function readMultipart(stream: ReadableStream<Uint8Array> | null, contentType: string, o: Omit<SpoolOptions, "onChunk"> = {}): Promise<ParsedForm> {
  const boundary = boundaryOf(contentType);
  if (!boundary) throw new MultipartError("Content-Type must be multipart/form-data with a boundary.");
  const scanner = new MultipartScanner(boundary);
  const spool = await BodySpool.fromStream(stream, { ...o, onChunk: (c) => scanner.push(c) });
  if (!scanner.complete) {
    await spool.dispose();
    throw new MultipartError();
  }
  return { fields: scanner.fields, files: scanner.files, order: scanner.order, spool, contentType, boundary, closeStart: scanner.closeStart };
}

/** Compatibility helper (tests, small buffers). */
export async function parseMultipart(body: Buffer, contentType: string): Promise<ParsedForm> {
  return readMultipart(new Response(new Uint8Array(body)).body, contentType);
}

export function getField(form: ParsedForm, name: string): string | undefined {
  return form.fields.find((f) => f.name === name)?.value;
}

const esc = (s: string) => s.replace(/"/g, "%22").replace(/\r|\n/g, " ");

/**
 * The upstream body as spool segments: the customer's bytes with the value of each overridden field replaced
 * (a missing field is appended before the closing delimiter). The Content-Type (boundary) stays the customer's.
 */
export function multipartSegments(form: ParsedForm, overrides: Record<string, string> = {}): Segment[] {
  const size = form.spool.size;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const [name, value] of Object.entries(overrides)) {
    const f = [...form.fields].reverse().find((x) => x.name === name);
    if (f) edits.push({ start: f.start, end: f.end, text: value });
    else edits.push({ start: form.closeStart, end: form.closeStart, text: `--${form.boundary}\r\nContent-Disposition: form-data; name="${esc(name)}"\r\n\r\n${value}\r\n` });
  }
  edits.sort((a, b) => a.start - b.start);
  const segs: Segment[] = [];
  let pos = 0;
  for (const e of edits) {
    if (e.start > pos) segs.push({ start: pos, end: e.start });
    segs.push(e.text);
    pos = e.end;
  }
  if (pos < size) segs.push({ start: pos, end: size });
  return segs;
}

/** In-memory forms only (tests, small bodies): the re-encoded body as a Buffer. */
export function encodeMultipart(form: ParsedForm, overrides: Record<string, string> = {}): { body: Buffer; contentType: string } {
  const segs = multipartSegments(form, overrides);
  const body = form.spool.inlineBuffer(segs, Number.MAX_SAFE_INTEGER);
  if (!body) throw new Error("encodeMultipart: form is not held in memory");
  return { body, contentType: form.contentType };
}

/** Total bytes of uploaded files (for duration estimates). */
export function fileBytes(form: ParsedForm): number {
  return form.files.reduce((a, f) => a + f.size, 0);
}
