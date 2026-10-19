import zlib from "node:zlib";
import { Readable, Transform as TransformStream } from "node:stream";
import type { Transform } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { GatewayError } from "./errors";

/**
 * Inbound request body access (PLAN 5c): the body is handed on as a STREAM and `Content-Encoding` (gzip / deflate /
 * br / zstd) is decoded on the fly - a client that compresses a huge prompt must still work, the upstream always gets
 * the plain body. Size limits (`maxRequestBodyMb`, 0 = unlimited) are enforced by the readers on the DECODED bytes.
 */
type Decoder = () => Transform;

/**
 * Decompression-bomb guard: a compressed body may expand to at most MAX_RATIO x its wire size once it is past FREE_BYTES
 * (a few hundred bytes of brotli can otherwise expand to gigabytes of memory / spool before any check runs).
 * Normal compressed JSON / text stays far below the ratio; uncompressed uploads are not affected (unlimited by design).
 */
export const BOMB_FREE_BYTES = 64 * 1024 * 1024;
export const BOMB_MAX_RATIO = 200;

function bombGuard(wire: { n: number }): Transform {
  let out = 0;
  return new TransformStream({
    transform(chunk: Buffer, _enc, cb) {
      out += chunk.length;
      if (out > BOMB_FREE_BYTES && out > wire.n * BOMB_MAX_RATIO) {
        cb(new GatewayError("payload_too_large", `The compressed request body expands more than ${BOMB_MAX_RATIO}x. Send it uncompressed or compress it less.`, { internal: `decompression bomb: ${wire.n} wire bytes -> more than ${out} decoded` }));
        return;
      }
      cb(null, chunk);
    },
  });
}

function decoderFor(name: string): Decoder | null {
  switch (name) {
    case "gzip":
    case "x-gzip":
      return () => zlib.createGunzip();
    case "deflate":
      return () => zlib.createInflate();
    case "br":
      return () => zlib.createBrotliDecompress();
    case "zstd": {
      const z = zlib as unknown as { createZstdDecompress?: () => Transform };
      return z.createZstdDecompress ? () => z.createZstdDecompress!() : null;
    }
    default:
      return null;
  }
}

/** Content-Encoding list in the order the encodings were APPLIED (null = nothing to decode). */
export function requestEncodings(headers: Headers): string[] | null {
  const raw = headers.get("content-encoding");
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== "identity");
  return list.length ? list : null;
}

/** The request body as a plain (decoded) byte stream, or null when there is none. Throws 415 for an encoding we cannot decode. */
export function inboundBody(req: Request): ReadableStream<Uint8Array> | null {
  const body = req.body;
  if (!body) return null;
  const encodings = requestEncodings(req.headers);
  if (!encodings) return body;
  const decoders: Decoder[] = [];
  for (const name of [...encodings].reverse()) {
    const d = decoderFor(name);
    if (!d) {
      throw new GatewayError("unsupported_media_type", `Content-Encoding '${name}' is not supported. Send the body uncompressed or use gzip, deflate, br or zstd.`, { param: "content-encoding" });
    }
    decoders.push(d);
  }
  const wire = { n: 0 };
  let node: Readable = Readable.fromWeb(body as unknown as NodeWebReadableStream);
  node.on("data", (c: Buffer) => (wire.n += c.length));
  for (const make of decoders) {
    const stage = make();
    // an error of the source (the client went away) is passed on to the decoder so the reader sees it
    node.on("error", (e) => stage.destroy(e));
    node = node.pipe(stage);
  }
  const guard = bombGuard(wire);
  node.on("error", (e) => guard.destroy(e));
  node = node.pipe(guard);
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
}
