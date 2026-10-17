"use client";

import { RouteError } from "@/components/common/route-states";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError error={error} reset={reset} title="Couldn't load billing" />;
}
