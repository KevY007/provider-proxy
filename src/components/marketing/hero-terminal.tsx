"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

const RESPONSE = `{
  "id": "chatcmpl-9f2c",
  "model": "MODEL",
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "One endpoint, every model."
    }
  }],
  "usage": { "prompt_tokens": 14, "completion_tokens": 7 }
}`;

/** Animated terminal: types a curl command, then "streams" the response. Respects reduced motion. */
export function HeroTerminal({ baseUrl, model }: { baseUrl: string; model: string }) {
  const command = `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer $API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${model}",
       "messages": [{"role":"user","content":"Hello!"}]}'`;
  const response = RESPONSE.replace("MODEL", model);
  const [typed, setTyped] = useState(0);
  const [shown, setShown] = useState(0);
  const [copied, setCopied] = useState(false);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced.current) {
      setTyped(command.length);
      setShown(response.length);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const run = () => {
      let i = 0;
      const type = () => {
        if (cancelled) return;
        i += 2 + Math.floor(Math.random() * 3);
        setTyped(Math.min(i, command.length));
        if (i < command.length) timer = setTimeout(type, 18);
        else timer = setTimeout(stream, 500);
      };
      let j = 0;
      const stream = () => {
        if (cancelled) return;
        j += 6;
        setShown(Math.min(j, response.length));
        if (j < response.length) timer = setTimeout(stream, 16);
        else timer = setTimeout(restart, 6000);
      };
      const restart = () => {
        if (cancelled) return;
        setTyped(0);
        setShown(0);
        timer = setTimeout(run, 600);
      };
      type();
    };
    run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [command, response]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command.replace("$API_KEY", "sk-pp-YOUR_API_KEY"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  const done = typed >= command.length;
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-[oklch(0.12_0.006_55)] text-left shadow-2xl shadow-primary/10 ring-1 ring-primary/10">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <span className="size-3 rounded-full bg-red-400/80" />
        <span className="size-3 rounded-full bg-amber-400/80" />
        <span className="size-3 rounded-full bg-emerald-400/80" />
        <span className="ml-3 font-mono text-xs text-white/50">~ / terminal</span>
        <button
          type="button"
          onClick={copy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/70 transition hover:bg-white/10 hover:text-white"
        >
          {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="min-h-[21rem] overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed text-white/90 sm:text-[13px]">
        <pre className="whitespace-pre-wrap break-words">
          <span className="text-primary">$ </span>
          {command.slice(0, typed)}
          {!done && <span className="ml-px inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-white/80" />}
        </pre>
        {done && (
          <pre className="mt-3 whitespace-pre-wrap break-words text-sky-300/90">
            {response.slice(0, shown)}
            {shown < response.length && <span className="ml-px inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-sky-300/80" />}
          </pre>
        )}
      </div>
    </div>
  );
}
