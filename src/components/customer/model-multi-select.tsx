"use client";

import { useState } from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { ModelOption } from "./snippet-tabs";

/** Searchable multi-select of models. Empty selection = "all models your pool allows". */
export function ModelMultiSelect({ models, value, onChange, id }: { models: ModelOption[]; value: string[]; onChange: (v: string[]) => void; id?: string }) {
  const [open, setOpen] = useState(false);
  const toggle = (slug: string) => onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug]);
  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button id={id} type="button" variant="outline" role="combobox" aria-expanded={open} className="w-full justify-between font-normal">
            <span className={cn("truncate", value.length === 0 && "text-muted-foreground")}>
              {value.length === 0 ? "All models allowed by the pool" : `${value.length} model${value.length === 1 ? "" : "s"} selected`}
            </span>
            <ChevronsUpDown className="size-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] min-w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search models..." />
            <CommandList>
              <CommandEmpty>No models found.</CommandEmpty>
              <CommandGroup>
                {models.map((m) => (
                  <CommandItem key={m.slug} value={`${m.slug} ${m.displayName} ${m.vendor}`} onSelect={() => toggle(m.slug)}>
                    <Check className={cn("size-4", value.includes(m.slug) ? "opacity-100" : "opacity-0")} />
                    <span className="truncate">{m.displayName}</span>
                    <span className="ml-auto truncate font-mono text-xs text-muted-foreground">{m.slug}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((slug) => (
            <Badge key={slug} variant="secondary" className="gap-1 pr-1 font-mono">
              {slug}
              <button type="button" aria-label={`Remove ${slug}`} className="rounded-full p-0.5 hover:bg-background/60" onClick={() => toggle(slug)}>
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
