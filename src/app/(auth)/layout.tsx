import Link from "next/link";
import { BrandMark } from "@/components/common/brand-mark";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const siteName = await getSetting("siteName");
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_50%_at_50%_0%,color-mix(in_oklab,var(--primary)_16%,transparent),transparent)]"
      />
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <Link href="/" className="mb-8 flex items-center gap-2 text-lg font-semibold">
        <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <BrandMark className="size-5" />
        </span>
        {siteName}
      </Link>
      {children}
    </div>
  );
}
