import { randomBytes } from "node:crypto";

/**
 * Minimal multipart/form-data support for the image-edit / audio-transcription passthrough: parse the customer's
 * body, swap the `model` field for the upstream model, and re-encode with a fresh boundary.
 */
export interface FormField {
  name: string;
  value: string;
}
export interface FormFile {
  name: string;
  filename: string;
  type: string;
  data: Buffer;
}
export interface ParsedForm {
  fields: FormField[];
  files: FormFile[];
  /** original part order (for faithful re-encoding) */
  order: Array<{ kind: "field" | "file"; index: number }>;
}

export async function parseMultipart(body: Buffer, contentType: string): Promise<ParsedForm> {
  const fd = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData();
  const form: ParsedForm = { fields: [], files: [], order: [] };
  for (const [name, value] of fd.entries()) {
    if (typeof value === "string") {
      form.order.push({ kind: "field", index: form.fields.length });
      form.fields.push({ name, value });
    } else {
      const file = value as File;
      form.order.push({ kind: "file", index: form.files.length });
      form.files.push({ name, filename: file.name || "file", type: file.type || "application/octet-stream", data: Buffer.from(await file.arrayBuffer()) });
    }
  }
  return form;
}

export function getField(form: ParsedForm, name: string): string | undefined {
  return form.fields.find((f) => f.name === name)?.value;
}

const esc = (s: string) => s.replace(/"/g, "%22").replace(/\r|\n/g, " ");

/** Encode `form` (with optional field overrides) as a multipart body. */
export function encodeMultipart(form: ParsedForm, overrides: Record<string, string> = {}): { body: Buffer; contentType: string } {
  const boundary = `----pp${randomBytes(12).toString("hex")}`;
  const chunks: Buffer[] = [];
  const seen = new Set<string>();
  for (const part of form.order) {
    if (part.kind === "field") {
      const f = form.fields[part.index];
      const value = f.name in overrides ? overrides[f.name] : f.value;
      seen.add(f.name);
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(f.name)}"\r\n\r\n${value}\r\n`));
    } else {
      const f = form.files[part.index];
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(f.name)}"; filename="${esc(f.filename)}"\r\nContent-Type: ${f.type}\r\n\r\n`));
      chunks.push(f.data, Buffer.from("\r\n"));
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!seen.has(name)) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${esc(name)}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Total bytes of uploaded files (for duration estimates). */
export function fileBytes(form: ParsedForm): number {
  return form.files.reduce((a, f) => a + f.data.length, 0);
}
