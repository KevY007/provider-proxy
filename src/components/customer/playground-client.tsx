"use client";

import { ImageIcon, MessageSquare } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatTab } from "./chat-tab";
import { ImageTab } from "./image-tab";
import { usePlaygroundKey } from "./playground-api";
import type { PlaygroundModel } from "./playground-shared";
import { VerifyBanner } from "./verify-banner";

export function PlaygroundClient({ chatModels, imageModels, poolName, savings, emailVerified, email }: { chatModels: PlaygroundModel[]; imageModels: PlaygroundModel[]; poolName: string; savings: string; emailVerified: boolean; email: string }) {
  const keyApi = usePlaygroundKey();
  // Hidden playground key: rotated each page load, held only in this component's memory.
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
        <p className="text-xs text-muted-foreground">
          Billed at your {poolName} pool prices{savings ? ` (${savings})` : ""}. Playground requests appear in your logs and usage.
        </p>
      </div>
      <TabsContent value="chat">
        <ChatTab models={chatModels} keyApi={keyApi} keyError={keyError} />
      </TabsContent>
      <TabsContent value="images">
        <ImageTab models={imageModels} keyApi={keyApi} keyError={keyError} />
      </TabsContent>
    </Tabs>
  );
}
