"use client";

import { useCallback, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { ActionResult } from "@/lib/auth/types";

export interface RunOptions<T> {
  /** Toast shown on success (defaults to the action's own `message`; pass "" to silence). */
  success?: string;
  /** Call router.refresh() after success so server components re-read data. Default true. */
  refresh?: boolean;
  onOk?: (data: T | undefined) => void;
  onError?: (error: string, fieldErrors?: Record<string, string>) => void;
  /** Toast the error. Default true. */
  toastError?: boolean;
}

/**
 * Client-side runner for server actions returning ActionResult.
 *
 *   const { run, pending, fieldErrors } = useAction();
 *   <Button onClick={() => run(() => disableKey(id), { success: "Key disabled" })} disabled={pending} />
 */
export function useAction() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [, startTransition] = useTransition();

  const run = useCallback(
    async <T,>(fn: () => Promise<ActionResult<T>>, opts: RunOptions<T> = {}): Promise<ActionResult<T>> => {
      setPending(true);
      setFieldErrors({});
      try {
        const res = await fn();
        if (res.ok) {
          const msg = opts.success ?? res.message;
          if (msg) toast.success(msg);
          if (opts.refresh !== false) startTransition(() => router.refresh());
          opts.onOk?.(res.data);
        } else {
          setFieldErrors(res.fieldErrors ?? {});
          if (opts.toastError !== false) toast.error(res.error);
          opts.onError?.(res.error, res.fieldErrors);
        }
        return res;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Request failed";
        if (opts.toastError !== false) toast.error(message);
        opts.onError?.(message);
        return { ok: false, error: message };
      } finally {
        setPending(false);
      }
    },
    [router],
  );

  return { run, pending, fieldErrors, clearErrors: () => setFieldErrors({}) };
}
