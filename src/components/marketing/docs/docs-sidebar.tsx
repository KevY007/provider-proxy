"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { DOC_SECTIONS, docHref } from "./registry";

/** Docs navigation tree. On small screens it collapses to a horizontally-scrolling list above the content. */
export function DocsSidebar() {
  const pathname = usePathname().replace(/\/$/, "") || "/";
  return (
    <nav aria-label="Documentation" className="space-y-6 text-sm">
      {DOC_SECTIONS.map((s) => (
        <div key={s.title}>
          <h4 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.title}</h4>
          <ul className="space-y-0.5">
            {s.pages.map((p) => {
              const href = docHref(p.slug);
              const active = pathname === href;
              return (
                <li key={p.slug}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                      active && "bg-primary/10 font-medium text-primary hover:bg-primary/10 hover:text-primary",
                    )}
                  >
                    {p.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
