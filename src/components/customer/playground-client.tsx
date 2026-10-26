"use client";

import { useState } from "react";
import { ImageIcon, MessageSquare } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatTab } from "./chat-tab";
import { ImageTab } from "./image-tab";
import { usePlaygroundKey } from "./playground-api";
import type { PlaygroundModel } from "./playground-shared";
import { VerifyBanner } from "./verify-banner";

/** A pool the customer may use, with its models at that pool's prices. */
export interface PlaygroundPool {
  id: string;
  name: string;
  savings: string;
  chatModels: PlaygroundModel[];
  imageModels: PlaygroundModel[];
}

export function PlaygroundClient({ pools, defaultPoolId, emailVerified, email }: { pools: PlaygroundPool[]; defaultPoolId: string | null; emailVerified: boolean; email: string }) {
  const [poolId, setPoolId] = useState(() => (pools.some((p) => p.id === defaultPoolId) ? defaultPoolId : (pools[0]?.id ?? null)));
  const pool = pools.find((p) => p.id === poolId) ?? pools[0];
  // Hidden playground key, minted in the chosen pool: rotated each page load / pool change, held only in memory.
  const keyApi = usePlaygroundKey(pool?.id ?? null);
  const keyError = emailVerified ? keyApi.error : null;
  if (!emailVerified) return <VerifyBanner email={email} />;
  return (
    <Tabs defaultValue="chat" className="gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList>
          <TabsTrigger value="chat">
            <MessageSquare className="size-4" /> Chat
          </TabsTrigger>
          <TabsTrigger value="images">
            <ImageIcon className="size-4" /> Image Studio
          </TabsTrigger>
        </TabsList>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {pools.length > 1 ? (
            <Select value={pool?.id ?? ""} onValueChange={setPoolId}>
              <SelectTrigger className="h-8 w-auto min-w-40" aria-label="Pool">
                <SelectValue placeholder="Pool" />
              </SelectTrigger>
              <SelectContent>
                {pools.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name} pool{p.savings ? ` - ${p.savings}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <span>
            Billed at {pool ? `${pool.name} pool` : "your pool's"} prices{pools.length <= 1 && pool?.savings ? ` (${pool.savings})` : ""}. Requests appear in your logs and usage.
          </span>
        </div>
      </div>
      {/* keyed by pool: each pool has its own model list, so the tabs start fresh on a pool change */}
      <TabsContent value="chat">
        <ChatTab key={pool?.id} models={pool?.chatModels ?? []} keyApi={keyApi} keyError={keyError} />
      </TabsContent>
      <TabsContent value="images">
        <ImageTab key={pool?.id} models={pool?.imageModels ?? []} keyApi={keyApi} keyError={keyError} />
      </TabsContent>
    </Tabs>
  );
}
