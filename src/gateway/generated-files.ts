import type { InboundFormat, Json } from "./types";
import { isObject } from "./util";

/**
 * Files the UPSTREAM creates while it serves a model request (not uploaded by the customer):
 *   - Anthropic code execution / text editor outputs: `file_id` entries inside `*_tool_result` content blocks
 *     (`bash_code_execution_tool_result.content.content[].file_id`, `text_editor_code_execution_tool_result ...`),
 *   - OpenAI Responses code interpreter: `container_file_citation` annotations (container id + file id, downloaded from
 *     `/v1/containers/{id}/files/{file}/content`) and `file_path` annotations (plain `/v1/files/{id}`).
 * The gateway records each one in `UpstreamObject` (owner = the calling customer, pinned to the upstream account that served
 * the request) so the normal Files endpoints work for them and nobody else can read them.
 */
export interface GeneratedFile {
  /** UpstreamObject.kind */
  kind: "file" | "container_file";
  /** UpstreamObject.upstreamId: the file id, or `<container id>/<file id>` for container files */
  id: string;
  /** Files API flavour the customer uses to download it */
  fmt: InboundFormat;
  filename?: string;
}

const MAX_WALK = 50_000;

/** Every `file_id` string below `value`. */
function fileIdsIn(value: unknown, into: Set<string>, budget: { n: number }, depth = 0): void {
  if (budget.n-- <= 0 || depth > 12) return;
  if (Array.isArray(value)) {
    for (const x of value) fileIdsIn(x, into, budget, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  for (const [k, x] of Object.entries(value)) {
    if (k === "file_id" && typeof x === "string" && x.length > 0 && x.length < 256) into.add(x);
    else if (typeof x === "object" && x !== null) fileIdsIn(x, into, budget, depth + 1);
  }
}

/** One Anthropic content block (response `content[]` entry or a streamed `content_block_start.content_block`). */
export function generatedFilesOfAnthropicBlock(block: Json): GeneratedFile[] {
  if (!isObject(block) || typeof block.type !== "string" || !block.type.endsWith("_tool_result")) return [];
  const ids = new Set<string>();
  fileIdsIn(block.content, ids, { n: MAX_WALK });
  return [...ids].map((id) => ({ kind: "file" as const, id, fmt: "anthropic_files" as const }));
}

/** An Anthropic Messages response: the files its code execution / text editor results reference. */
export function generatedFilesOfAnthropicMessage(msg: Json): GeneratedFile[] {
  if (!isObject(msg) || !Array.isArray(msg.content)) return [];
  const seen = new Set<string>();
  const out: GeneratedFile[] = [];
  for (const b of msg.content) {
    for (const f of generatedFilesOfAnthropicBlock(b)) {
      if (!seen.has(f.id)) {
        seen.add(f.id);
        out.push(f);
      }
    }
  }
  return out;
}

/** The `output` items of an OpenAI Responses response: container files and file paths named in message annotations. */
export function generatedFilesOfResponsesOutput(output: Json): GeneratedFile[] {
  if (!Array.isArray(output)) return [];
  const seen = new Set<string>();
  const out: GeneratedFile[] = [];
  const add = (f: GeneratedFile) => {
    const key = `${f.kind}:${f.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  const visitAnnotation = (a: Json) => {
    if (!isObject(a)) return;
    if (a.type === "container_file_citation" && typeof a.container_id === "string" && typeof a.file_id === "string") {
      add({ kind: "container_file", id: `${a.container_id}/${a.file_id}`, fmt: "openai_files", filename: typeof a.filename === "string" ? a.filename : undefined });
    } else if (a.type === "file_path" && typeof a.file_id === "string") {
      add({ kind: "file", id: a.file_id, fmt: "openai_files" });
    }
  };
  for (const item of output) {
    if (!isObject(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isObject(part) && Array.isArray(part.annotations)) for (const a of part.annotations) visitAnnotation(a);
    }
  }
  return out;
}
