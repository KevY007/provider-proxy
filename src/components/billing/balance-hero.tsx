import { Wallet } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/common/status-badge";
import { MoneyText } from "@/components/common/money-text";
import { toDecimal } from "@/lib/money";
import { cn } from "@/lib/utils";

export function BalanceHero({
  balance,
  creditLimit,
  billingMode,
  monthSpend,
  monthSpendLimit,
}: {
  balance: string;
  creditLimit: string;
  billingMode: "PREPAID" | "POSTPAID";
  monthSpend: string;
  monthSpendLimit: string | null;
}) {
  const bal = toDecimal(balance);
  const limit = toDecimal(creditLimit);
  const postpaid = billingMode === "POSTPAID";
  const available = bal.plus(limit);
  return (
    <Card className="overflow-hidden">
      <CardContent className="grid gap-6 p-6 sm:grid-cols-[1fr_auto] sm:items-center">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Wallet className="size-4" />
            <span>Current balance</span>
            <StatusBadge status={billingMode} label={postpaid ? "Postpaid" : "Prepaid"} dot={false} />
          </div>
          <p className={cn("text-4xl font-semibold tracking-tight tabular-nums sm:text-5xl", bal.isNegative() && "text-red-500")}>
            <MoneyText value={bal} />
          </p>
          <p className="text-sm text-muted-foreground">
            {postpaid ? (
              <>
                Credit limit <MoneyText value={limit} /> &middot; available to spend <MoneyText value={available} />. Outstanding usage is charged to your saved card automatically.
              </>
            ) : bal.lte(0) ? (
              "Your balance is empty - add credit to keep making API requests."
            ) : (
              "Usage is deducted from this balance per request."
            )}
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-6 border-t pt-4 text-sm sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
          <div>
            <dt className="text-muted-foreground">Spent this month</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">
              <MoneyText value={monthSpend} />
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Monthly limit</dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums">{monthSpendLimit ? <MoneyText value={monthSpendLimit} /> : <span className="text-muted-foreground">None</span>}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}
