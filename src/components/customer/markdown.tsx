"use client";

import { Fragment } from "react";
import { CopyButton } from "@/components/common/copy-button";
import { cn } from "@/lib/utils";

/**
 * Tiny, dependency-free markdown renderer for assistant replies: fenced code (with copy), inline code,
 * bold/italic, links, headings, bullet/numbered lists, blockquotes and paragraphs. Produces React elements only
 * (never raw HTML), and only http(s)/mailto links, so model output can't inject markup.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className={cn("space-y-3 text-sm leading-relaxed [&_a]:text-primary [&_a]:underline-offset-2 hover:[&_a]:underline", className)}>
      {blocks.map((b, i) => (
        <Block key={i} block={b} />
      ))}
    </div>
  );
}

type BlockT =
  | { t: "code"; lang: string; code: string; open: boolean }
  | { t: "heading"; level: number; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "quote"; text: string }
  | { t: "p"; text: string };

export function parseBlocks(src: string): BlockT[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: BlockT[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (/^\s*```\s*$/.test(lines[i])) {
          closed = true;
          i++;
          break;
        }
        buf.push(lines[i]);
        i++;
      }
      out.push({ t: "code", lang: fence[1], code: buf.join("\n"), open: !closed });
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: "heading", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
      out.push({ t: "ul", items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      out.push({ t: "ol", items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push({ t: "quote", text: buf.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^\s*```/.test(lines[i]) && !/^(#{1,4})\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i]) && !/^>\s?/.test(lines[i])) buf.push(lines[i++]);
    out.push({ t: "p", text: buf.join("\n") });
  }
  return out;
}

function Block({ block }: { block: BlockT }) {
  switch (block.t) {
    case "code":
      return (
        <div className="overflow-hidden rounded-lg border bg-muted/40">
          <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-1">
            <span className="font-mono text-xs text-muted-foreground">{block.lang || "text"}</span>
            <CopyButton value={block.code} size="icon-xs" toastMessage="Code copied" />
          </div>
          <pre className="overflow-x-auto p-3 font-mono text-[12.5px] leading-relaxed">
            <code>{block.code}</code>
          </pre>
        </div>
      );
    case "heading": {
      const cls = block.level <= 2 ? "text-base font-semibold" : "text-sm font-semibold";
      return <p className={cls}>{inline(block.text)}</p>;
    }
    case "ul":
      return (
        <ul className="list-disc space-y-1 pl-5">
          {block.items.map((it, i) => (
            <li key={i}>{inline(it)}</li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol className="list-decimal space-y-1 pl-5">
          {block.items.map((it, i) => (
            <li key={i}>{inline(it)}</li>
          ))}
        </ol>
      );
    case "quote":
      return <blockquote className="border-l-2 pl-3 text-muted-foreground">{inline(block.text)}</blockquote>;
    default:
      return <p className="whitespace-pre-wrap">{inline(block.text)}</p>;
  }
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

export function inline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) parts.push(<Fragment key={k++}>{text.slice(last, idx)}</Fragment>);
    const tok = m[0];
    if (m[1]) parts.push(<code key={k++} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{tok.slice(1, -1)}</code>);
    else if (m[2]) parts.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) parts.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    else if (m[4]) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (mm && /^(https?:\/\/|mailto:)/i.test(mm[2])) {
        parts.push(
          <a key={k++} href={mm[2]} target="_blank" rel="noopener noreferrer nofollow">
            {mm[1]}
          </a>,
        );
      } else parts.push(<Fragment key={k++}>{tok}</Fragment>);
    }
    last = idx + tok.length;
  }
  if (last < text.length) parts.push(<Fragment key={k++}>{text.slice(last)}</Fragment>);
  return parts;
}
