"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getPlaygroundKeyAction } from "@/server/customer/playground";

/** Browser-side helpers for talking to our own gateway (/v1/*) with the hidden playground key. */

export interface GatewayError {
  status: number;
  code: string | null;
  message: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export type ChatTurn = { role: "system" | "user" | "assistant"; content: string };

/**
 * Holds the playground key in memory only. `getKey()` lazily fetches (rotates) one; `renew()` forces a fresh one.
 * `groupId` is the pool the playground bills at (null = the account default); changing it mints a key in that pool.
 */
export function usePlaygroundKey(groupId: string | null = null) {
  const keyRef = useRef<string | null>(null);
  const inflight = useRef<Promise<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const fetchKey = useCallback(async (): Promise<string> => {
    if (!inflight.current) {
      inflight.current = (async () => {
        const r = await getPlaygroundKeyAction(groupId);
        if (!r.ok || !r.data) {
          setError(r.ok ? "Could not create a playground key" : r.error);
          throw new Error(r.ok ? "no key" : r.error);
        }
        keyRef.current = r.data.key;
        setError(null);
        setReady(true);
        return r.data.key;
      })().finally(() => {
        inflight.current = null;
      });
    }
    return inflight.current;
  }, [groupId]);

  const getKey = useCallback(async () => keyRef.current ?? fetchKey(), [fetchKey]);
  const renew = useCallback(async () => {
    keyRef.current = null;
    return fetchKey();
  }, [fetchKey]);

  useEffect(() => {
    keyRef.current = null; // another pool: the key must be re-minted in it
    inflight.current = null;
    fetchKey().catch(() => undefined);
  }, [fetchKey]);

  return { getKey, renew, error, ready };
}

export async function readGatewayError(res: Response): Promise<GatewayError> {
  let code: string | null = null;
  let message = `Request failed (HTTP ${res.status})`;
  try {
    const body = await res.json();
    const e = body?.error;
    if (typeof e === "string") message = e;
    else if (e) {
      message = e.message ?? message;
      code = e.code ?? (typeof e.type === "string" ? e.type : null);
    }
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, code, message };
}

/** fetch against the gateway; transparently re-mints the playground key once on 401 (e.g. rotated by another tab). */
export async function gatewayFetch(path: string, init: RequestInit, key: { getKey: () => Promise<string>; renew: () => Promise<string> }): Promise<Response> {
  const go = async (k: string) => fetch(path, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${k}`, "Content-Type": "application/json" } });
  let res = await go(await key.getKey());
  if (res.status === 401) res = await go(await key.renew());
  return res;
}

/** Parses an OpenAI SSE chat stream, calling back for text deltas and the final usage. */
export async function readChatStream(res: Response, onDelta: (text: string) => void, onUsage: (u: ChatUsage) => void): Promise<void> {
  if (!res.body) throw new Error("Empty response body");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) onDelta(delta);
        if (j.usage) {
          onUsage({
            inputTokens: j.usage.prompt_tokens ?? 0,
            outputTokens: j.usage.completion_tokens ?? 0,
            cachedTokens: j.usage.prompt_tokens_details?.cached_tokens ?? 0,
          });
        }
        if (j.error) throw new Error(j.error.message ?? "Stream error");
      } catch (err) {
        if (err instanceof SyntaxError) continue; // partial / non-JSON keepalive
        throw err;
      }
    }
  }
}
