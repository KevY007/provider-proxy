import { cn } from "@/lib/utils";

/** The logo glyph (same drawing as src/app/icon.svg): one endpoint fanning out to many providers. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("size-4", className)} fill="currentColor" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 12h5.5M12.5 12l4.6-5.6M12.5 12h4.5M12.5 12l4.6 5.6" fill="none" />
      <g stroke="none">
        <circle cx="4.5" cy="12" r="2.8" />
        <circle cx="19.5" cy="4.5" r="2.8" />
        <circle cx="19.5" cy="12" r="2.8" />
        <circle cx="19.5" cy="19.5" r="2.8" />
      </g>
    </svg>
  );
}
