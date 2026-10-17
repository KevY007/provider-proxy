import zlib from "node:zlib";
import { Readable, type Transform } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { GatewayError } from "./errors";

/**
 * Inbound request body access (PLAN 5c): the body is handed on as a STREAM and `Content-Encoding` (gzip / deflate /
 * br / zstd) is decoded on the fly - a client that compresses a huge prompt must still work, the upstream always gets
 * the plain body. Size limits (`maxRequestBodyMb`, 0 = unlimited) are enforced by the readers on the DECODED bytes.
 */
type Decoder = () => Transform;

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
  let node: Readable = Readable.fromWeb(body as unknown as NodeWebReadableStream);
  for (const make of decoders) {
    const stage = make();
    // an error of the source (the client went away) is passed on to the decoder so the reader sees it
    node.on("error", (e) => stage.destroy(e));
    node = node.pipe(stage);
  }
  return Readable.toWeb(node) as unknown as ReadableStream<Uint8Array>;
}
