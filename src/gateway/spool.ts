import { createReadStream, createWriteStream, promises as fsp, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";

/**
 * Request-body spool (PLAN 5c / 9d): holds an uploaded body that must be read completely BEFORE it can be forwarded
 * (the routing decision depends on `model`, which clients may send after a huge file part), without ever holding a
 * large upload in memory. Small bodies stay in memory; once a body grows past `memLimit` it is written to a temp file
 * and only O(chunk) memory is used from then on. The spool can be re-read any number of times (failover attempts) and
 * replayed with byte ranges replaced / inserted ("splice"), so a body is forwarded byte-identical except for the few
 * bytes we must change (e.g. the `model` value).
 */
export type Segment = { start: number; end: number } | Uint8Array | string;

export const DEFAULT_MEM_LIMIT = 8 * 1024 * 1024;

export interface SpoolOptions {
  memLimit?: number;
  /** Fail (throws SpoolLimitError) when the body grows past this many bytes. 0 / undefined = unlimited. */
  maxBytes?: number;
  /** Called with every chunk, in order, before it is stored (streaming scanners). */
  onChunk?: (chunk: Buffer, offset: number) => void;
}

export class SpoolLimitError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "SpoolLimitError";
  }
}

export class BodySpool {
  private chunks: Buffer[] = [];
  private file: string | null = null;
  private writer: WriteStream | null = null;
  private _size = 0;
  private disposed = false;

  private constructor(private readonly memLimit: number) {}

  get size(): number {
    return this._size;
  }

  /** true while the whole body is in memory */
  get inMemory(): boolean {
    return this.file === null;
  }

  /** Drain `stream` into a new spool. Rejects with the stream's error (e.g. the client went away) or SpoolLimitError. */
  static async fromStream(stream: ReadableStream<Uint8Array> | null, o: SpoolOptions = {}): Promise<BodySpool> {
    const spool = new BodySpool(o.memLimit ?? DEFAULT_MEM_LIMIT);
    try {
      if (stream) {
        const reader = stream.getReader();
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          const chunk = Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength);
          // (the request stream is NOT cancelled: that would reset the connection before the 413 can be delivered)
          if (o.maxBytes && spool._size + chunk.length > o.maxBytes) throw new SpoolLimitError(o.maxBytes);
          o.onChunk?.(chunk, spool._size);
          await spool.append(chunk);
        }
      }
      await spool.finishWriting();
      return spool;
    } catch (e) {
      await spool.dispose();
      throw e;
    }
  }

  static fromBuffer(buf: Buffer): BodySpool {
    const s = new BodySpool(Number.MAX_SAFE_INTEGER);
    s.chunks.push(buf);
    s._size = buf.length;
    return s;
  }

  private async append(chunk: Buffer): Promise<void> {
    this._size += chunk.length;
    if (this.file === null) {
      this.chunks.push(chunk);
      if (this._size > this.memLimit) await this.spill();
      return;
    }
    await this.write(chunk);
  }

  private writeError: Error | null = null;

  private async spill(): Promise<void> {
    this.file = path.join(tmpdir(), `pp-spool-${randomBytes(8).toString("hex")}`);
    this.writer = createWriteStream(this.file, { flags: "wx", mode: 0o600 });
    this.writer.on("error", (e) => (this.writeError = e));
    const pending = this.chunks;
    this.chunks = [];
    for (const c of pending) await this.write(c);
  }

  private async write(chunk: Buffer): Promise<void> {
    const w = this.writer!;
    if (this.writeError) throw this.writeError;
    if (!w.write(chunk)) await once(w, "drain");
    if (this.writeError) throw this.writeError;
  }

  private async finishWriting(): Promise<void> {
    const w = this.writer;
    if (!w) return;
    w.end();
    await once(w, "finish");
    this.writer = null;
    if (this.writeError) throw this.writeError;
  }

  /** The whole body as one Buffer (memory cost = body size). */
  async toBuffer(): Promise<Buffer> {
    if (this.file === null) return this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    return fsp.readFile(this.file);
  }

  /** Bytes [start, end) as a Buffer (small ranges only). */
  async slice(start: number, end: number): Promise<Buffer> {
    if (this.file === null) return (await this.toBuffer()).subarray(start, end);
    const fh = await fsp.open(this.file, "r");
    try {
      const out = Buffer.alloc(Math.max(0, end - start));
      await fh.read(out, 0, out.length, start);
      return out;
    } finally {
      await fh.close();
    }
  }

  /** Total length of a spliced body. */
  static lengthOf(segments: Segment[]): number {
    let n = 0;
    for (const s of segments) n += typeof s === "string" ? Buffer.byteLength(s) : s instanceof Uint8Array ? s.byteLength : s.end - s.start;
    return n;
  }

  /** The body (or a spliced version of it) as a fresh stream; every call starts from the beginning. */
  stream(segments: Segment[] = [{ start: 0, end: this._size }]): ReadableStream<Uint8Array> {
    return Readable.toWeb(Readable.from(this.generate(segments), { objectMode: false })) as unknown as ReadableStream<Uint8Array>;
  }

  private async *generate(segments: Segment[]): AsyncGenerator<Uint8Array> {
    for (const seg of segments) {
      if (typeof seg === "string") yield Buffer.from(seg);
      else if (seg instanceof Uint8Array) yield seg;
      else if (seg.end > seg.start) {
        if (this.file === null) {
          const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
          if (this.chunks.length > 1) this.chunks = [all];
          yield all.subarray(seg.start, seg.end);
        } else {
          for await (const c of createReadStream(this.file, { start: seg.start, end: seg.end - 1, highWaterMark: 256 * 1024 })) yield c as Buffer;
        }
      }
    }
  }

  /** The spliced body as a Buffer when it is small and in memory (retry-friendly), else null. */
  inlineBuffer(segments: Segment[], maxBytes = DEFAULT_MEM_LIMIT): Buffer | null {
    if (this.file !== null || BodySpool.lengthOf(segments) > maxBytes) return null;
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const parts: Buffer[] = [];
    for (const seg of segments) {
      if (typeof seg === "string") parts.push(Buffer.from(seg));
      else if (seg instanceof Uint8Array) parts.push(Buffer.from(seg.buffer, seg.byteOffset, seg.byteLength));
      else parts.push(all.subarray(seg.start, seg.end));
    }
    return Buffer.concat(parts);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.chunks = [];
    const w = this.writer;
    this.writer = null;
    if (w) w.destroy();
    const f = this.file;
    this.file = null;
    if (f) await fsp.rm(f, { force: true }).catch(() => undefined);
  }
}
