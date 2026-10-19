"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

/** Refreshes the server-rendered page every `seconds` and shows a countdown-ish indicator. */
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  const [spinning, setSpinning] = useState(false);
  useEffect(() => {
    const id = setInterval(() => {
      setSpinning(true);
      router.refresh();
      setTimeout(() => setSpinning(false), 800);
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <RefreshCw className={`size-3 ${spinning ? "animate-spin" : ""}`} />
      Auto-refreshes every {seconds}s
    </span>
  );
}
