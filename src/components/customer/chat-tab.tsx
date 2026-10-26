"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Eraser, Send, Square, User } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/common/empty-state";
import { MoneyText } from "@/components/common/money-text";
import { cn, formatNumber } from "@/lib/utils";
import { estimateCost, estimateSaving } from "@/server/customer/pricing";
import { Markdown } from "./markdown";
import { gatewayFetch, readChatStream, readGatewayError, type ChatTurn, type ChatUsage, type GatewayError, type usePlaygroundKey } from "./playground-api";
import { GatewayErrorAlert, SavedNote, type PlaygroundModel } from "./playground-shared";

interface Msg {
  id: number;
  role: "user" | "assistant";
  content: string;
  model?: string;
  usage?: ChatUsage;
  cost?: string;
  saved?: string | null;
  error?: GatewayError;
  streaming?: boolean;
  stopped?: boolean;
}

let nextId = 1;

export function ChatTab({ models, keyApi, keyError }: { models: PlaygroundModel[]; keyApi: ReturnType<typeof usePlaygroundKey>; keyError: string | null }) {
  const [model, setModel] = useState(models[0]?.slug ?? "");
  const [system, setSystem] = useState("");
  const [temperature, setTemperature] = useState("1");
  const [maxTokens, setMaxTokens] = useState("");
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const current = models.find((m) => m.slug === model);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [msgs]);

  const total = msgs.reduce((a, m) => a + Number(m.cost ?? 0), 0);
  const totalSaved = msgs.reduce((a, m) => a + Number(m.saved ?? 0), 0);
  const anySaved = msgs.some((m) => m.saved != null);

  function patch(id: number, p: Partial<Msg>) {
    setMsgs((all) => all.map((m) => (m.id === id ? { ...m, ...p } : m)));
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || !current) return;
    const temp = Number(temperature);
    const max = maxTokens.trim() ? Number(maxTokens) : undefined;
    if (!Number.isFinite(temp) || temp < 0 || temp > 2) return void toast.error("Temperature must be between 0 and 2");
    if (max !== undefined && (!Number.isInteger(max) || max < 1)) return void toast.error("Max tokens must be a positive whole number");

    const history: ChatTurn[] = msgs.filter((m) => !m.error && m.content).map((m) => ({ role: m.role, content: m.content }));
    const turns: ChatTurn[] = [...(system.trim() ? [{ role: "system" as const, content: system.trim() }] : []), ...history, { role: "user", content: text }];
    const userMsg: Msg = { id: nextId++, role: "user", content: text };
    const aId = nextId++;
    setMsgs((all) => [...all, userMsg, { id: aId, role: "assistant", content: "", model: current.slug, streaming: true }]);
    setInput("");
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    let acc = "";
    let usage: ChatUsage | null = null;
    try {
      const res = await gatewayFetch(
        "/v1/chat/completions",
        {
          method: "POST",
          signal: ac.signal,
          body: JSON.stringify({ model: current.slug, messages: turns, stream: true, stream_options: { include_usage: true }, temperature: temp, ...(max ? { max_tokens: max } : {}) }),
        },
        keyApi,
      );
      if (!res.ok) {
        patch(aId, { streaming: false, error: await readGatewayError(res) });
        return;
      }
      await readChatStream(
        res,
        (d) => {
          acc += d;
          patch(aId, { content: acc });
        },
        (u) => {
          usage = u;
        },
      );
      const u = usage as ChatUsage | null;
      patch(aId, { streaming: false, usage: u ?? undefined, cost: u ? estimateCost(u, current.prices).toString() : undefined, saved: u ? estimateSaving(u, current.official, current.prices) : undefined });
    } catch (err) {
      if (ac.signal.aborted) {
        patch(aId, { streaming: false, stopped: true });
      } else {
        patch(aId, { streaming: false, error: { status: 0, code: null, message: err instanceof Error ? err.message : "Network error" } });
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <Card className="flex h-[calc(100vh-18rem)] min-h-[28rem] flex-col gap-0 p-0">
        <div className="flex-1 space-y-5 overflow-y-auto p-4">
          {msgs.length === 0 ? (
            <EmptyState icon={Bot} title="Start a conversation" description="Pick a model, optionally set a system prompt, and send a message. Usage is billed to your balance at your pool's price." className="h-full border-0" />
          ) : (
            msgs.map((m) => <Bubble key={m.id} m={m} />)
          )}
          <div ref={endRef} />
        </div>
        <div className="border-t p-3">
          {keyError && <p className="mb-2 text-sm text-red-500">{keyError}</p>}
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Message the model... (Enter to send, Shift+Enter for a new line)"
              rows={2}
              className="max-h-40 min-h-12 resize-none"
              aria-label="Message"
            />
            {busy ? (
              <Button variant="destructive" onClick={() => abortRef.current?.abort()} aria-label="Stop generating">
                <Square className="size-4" /> Stop
              </Button>
            ) : (
              <Button onClick={() => void send()} disabled={!input.trim() || !current || !!keyError} aria-label="Send message">
                <Send className="size-4" /> Send
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="space-y-4">
        <Card className="gap-4 p-4">
          <Field>
            <FieldLabel>Model</FieldLabel>
            <Select value={model} onValueChange={setModel}>
              <SelectTrigger className="w-full" aria-label="Model">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {models.map((m) => (
                  <SelectItem key={m.slug} value={m.slug}>
                    {m.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {current && (
              <FieldDescription>
                <MoneyText value={current.prices.input} /> in / <MoneyText value={current.prices.output} /> out per 1M tokens
              </FieldDescription>
            )}
          </Field>
          <Field>
            <FieldLabel htmlFor="sys">System prompt</FieldLabel>
            <Textarea id="sys" rows={4} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="You are a helpful assistant." />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="temp">Temperature</FieldLabel>
              <Input id="temp" type="number" min={0} max={2} step={0.1} value={temperature} onChange={(e) => setTemperature(e.target.value)} />
            </Field>
            <Field>
              <FieldLabel htmlFor="maxtok">Max tokens</FieldLabel>
              <Input id="maxtok" type="number" min={1} placeholder="Auto" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
            </Field>
          </div>
          <div className="flex items-center justify-between border-t pt-3 text-sm">
            <span className="text-muted-foreground">Session cost</span>
            <MoneyText value={total} />
          </div>
          {anySaved && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Saved</span>
              <SavedNote saved={String(totalSaved)} />
            </div>
          )}
          <Button variant="outline" size="sm" onClick={() => setMsgs([])} disabled={busy || msgs.length === 0}>
            <Eraser className="size-4" /> Clear conversation
          </Button>
        </Card>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: Msg }) {
  const isUser = m.role === "user";
  return (
    <div className={cn("flex gap-3", isUser && "flex-row-reverse")}>
      <div className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", isUser ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground")}>{isUser ? <User className="size-4" /> : <Bot className="size-4" />}</div>
      <div className={cn("min-w-0 max-w-[85%] space-y-2", isUser && "text-right")}>
        <div className={cn("max-w-full rounded-2xl px-4 py-2.5 text-left", isUser ? "inline-block bg-primary/10" : "inline-block bg-muted/50", !isUser && !m.content && !m.streaming && !m.stopped && "hidden")}>
          {isUser ? (
            <p className="whitespace-pre-wrap text-sm">{m.content}</p>
          ) : m.content ? (
            <Markdown text={m.content} />
          ) : m.streaming ? (
            <span className="inline-flex gap-1 py-1" aria-label="Generating">
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
            </span>
          ) : m.stopped ? (
            <span className="text-sm italic text-muted-foreground">Stopped before any output.</span>
          ) : null}
        </div>
        {m.error && <GatewayErrorAlert error={m.error} />}
        {!isUser && (m.usage || m.stopped) && (
          <p className="text-xs text-muted-foreground">
            {m.model}
            {m.usage && (
              <>
                {" - "}
                {formatNumber(m.usage.inputTokens)} in{m.usage.cachedTokens ? ` (${formatNumber(m.usage.cachedTokens)} cached)` : ""} / {formatNumber(m.usage.outputTokens)} out
                {m.cost && (
                  <>
                    {" - "}
                    <MoneyText value={m.cost} />
                    {m.saved != null && Number(m.saved) !== 0 && (
                      <>
                        {" - "}
                        <SavedNote saved={m.saved} />
                      </>
                    )}
                  </>
                )}
              </>
            )}
            {m.stopped && " - stopped"}
          </p>
        )}
      </div>
    </div>
  );
}
