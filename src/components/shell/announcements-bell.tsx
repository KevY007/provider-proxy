"use client";

import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export interface AnnouncementItem {
  id: string;
  title: string;
  body: string;
  level: string; // "info" | "warning" | "success" | "error"
  createdAt: string; // ISO
}

const levelDot: Record<string, string> = {
  info: "bg-sky-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
};

/** Bell with the active announcements (fed by the shell layouts from the Announcement table). */
export function AnnouncementsBell({ items }: { items: AnnouncementItem[] }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Announcements (${items.length})`}>
          <Bell className="size-4" />
          {items.length > 0 && (
            <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-primary ring-2 ring-background" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-4 py-3 text-sm font-medium">Announcements</div>
        {items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing new right now.</p>
        ) : (
          <ul className="max-h-80 divide-y overflow-y-auto">
            {items.map((a) => (
              <li key={a.id} className="space-y-1 px-4 py-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span className={cn("size-2 rounded-full", levelDot[a.level] ?? levelDot.info)} />
                  {a.title}
                </div>
                <p className="text-sm text-muted-foreground">{a.body}</p>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
