# Pricing and billing

Code: `src/gateway/pricing.ts` (the math, pure), `src/server/pricing/` (rules), `src/gateway/reserve.ts` +
`holds.ts` (funds protection), `src/server/billing/` (Stripe, ledger, auto-recharge, postpaid, redeem codes).
All money is USD in `Decimal(24,12)`. Prices are **USD per 1M units** unless noted (per image, per request,
per minute, per second, per tool unit).

## Vocabulary

Use exactly these labels. Never say "upstream/downstream" price.

| Term | Who sees it | Meaning |
|---|---|---|
| **Official price** | everyone | The vendor's public list price for that exact model. Used for reference and savings. |
| **Your price** | customer UI | What we charge this customer, with pool and customer multipliers applied |
| **Customer price** | admin UI | The same number from the admin's side (Model sell prices, before multipliers) |
| **Our cost** | admin only | What we pay the supplier (route cost fields) |
| **Savings** | everyone | Official - Your price. Shown green as "-62% vs official"; when negative, shown neutral/amber as "+15% vs official", never hidden. |
| **Margin** | admin only | Customer price - Our cost (red with a warning when <= 0) |

## Pricing rules (per model)

| `pricingMode` | Customer price |
|---|---|
| `FIXED` | Typed by the admin |
| `PERCENT_OF_OFFICIAL` | official x `pricingValue` / 100 |
| `MARKUP_OVER_COST` | primary route cost x (1 + `pricingValue` / 100). The primary route is the highest-priority enabled route (ties: higher weight, then oldest). |
| `PERCENT_OF_COST` | primary route cost x `pricingValue` / 100 (e.g. 50 = half of what the provider charges us; the preview warns when that is a loss) |

**Adjustment** (`Model.pricingAdjust`, optional, any derived rule): a signed USD amount added to every per-unit price
*after* the % / markup, e.g. `-0.05` = "5 cents less per 1M tokens / per image". A price never goes below 0.
Server-tool prices are not adjusted.

**Auto-updated cost** (`ModelRoute.autoCostSync`): the route's cost follows the price the provider publishes through
its own API (OpenRouter, LiteLLM `/model/info`, another ProviderProxy's `x_pricing`, ... - see "Fetch pricing" in the
admin guide). Combined with a cost-based rule this gives "the provider's price minus 5 cents" or "50% of the
provider's price" that stays correct when the provider changes its prices. There are **no timers**: a refresh only
happens during a real call on that route, when the last refresh is older than `autoPriceSyncHours` (default 6) or
`autoPriceSyncCalls` (default 100) calls happened since - whichever comes first - or when an admin clicks **Sync
now**. A route nobody calls never asks the provider. Refreshes of one route are at least a minute apart across all
instances, provider price lists are cached 5 minutes, every change is audited (`route.auto_cost_sync`) and customer
prices are re-derived immediately. `autoCostSourceModel` names the model in the provider's list when it differs
from the upstream model. Status per route: `ok`, `unchanged`, `not published`, `provider unreachable`.

**Default policy** (`src/server/pricing/default-policy.ts`, used by the seed, `pnpm setup:live` and the Add-model
wizard): a model with an official price uses **match official** (`PERCENT_OF_OFFICIAL` 100, server-tool prices
included). A model without one uses **cost + 30%** (`MARKUP_OVER_COST` 30). Route cost is set to the supplier's list
price. The public price table only shows a saving when our price is below the official one.

Derived prices are recomputed (`onModelPricingInputsChanged`) when the rule, an official price, or the primary route's
cost, priority or enabled flag changes. A unit without a basis keeps its typed value. Server-tool prices follow the
same rule (official tool price x %, or route tool cost x markup).

## Multipliers (pools and customers)

```
multiplier = (customer.priceMultiplier ?? 1) x group.priceMultiplier
```

The group is the key's group, else the customer's group, else the default. The seeded pools are `standard` 1.0,
`pro` 0.8 and `enterprise` 0.6. The multiplier applies to **everything** the customer pays (token and flat parts).
It never applies to our cost.

## The formula (`computeAmount` / `priceRequest`)

```
lc       = (longContextThreshold && inputTokens > threshold) ? longContextMultiplier : 1
tokens$  = ( uncachedInput x input + cached x (cachedInput ?? input)
           + cacheWrite5m x (cacheWrite ?? input) + cacheWrite1h x (cacheWrite1h ?? cacheWrite ?? input)
           + output x output + audioIn x audioInput + audioOut x audioOutput ) / 1e6
tokens$  = tokens$ x lc                         (long-context factor first)
tokens$  = tokens$ x (1 - batchDiscountPct/100) (Batch API results only)
flat$    = images x image + request (successful requests only) + audioSeconds/60 x perMinute
         + chars x perMillionChars / 1e6 + videoSeconds x perSecond + sum(toolUsage[k] x tools[k])
price    = (tokens$ + flat$) x multiplier       rounded to 12 dp
cost     = same with the route's cost fields, the route's batchCostDiscountPct, and NO multiplier
profit   = price - cost
```

Notes:
- `inputTokens` is the **total** prompt including cache reads and writes. Anthropic reports those separately and the
  gateway normalises it, so `uncachedInput = input - cached - cacheWrite`.
- Output includes reasoning/thinking tokens.
- **Cache pricing**: cache reads use `cachedInputPrice` (falling back to input). 5-minute writes use
  `cacheWritePrice`. 1-hour writes use `cacheWrite1hPrice`, then `cacheWritePrice`, then input.
- **Long context**: the factor applies to the token part only, and only when the request's input is above the
  threshold. It applies to the whole token part, not only the tokens above the threshold.
- **Audio** tokens are a subset of input/output. When an audio price is set they are billed at that rate instead of
  the text rate, never both.
- **Images**: with a flat `imagePrice` and images generated, token usage is not billed in addition. Token-billed
  image models bill the reported usage.
- **Server tools** (`toolPrices` / `toolCosts` / `officialToolPrices`, JSON maps of USD per unit). Keys used by the
  metering: Anthropic `web_search_request`, `web_fetch_request`, `code_execution_request`, and
  `code_execution_hour` (one 5-minute container minimum, `1/12`, counted only when code execution ran without web
  search/fetch). Responses API: `web_search_call`, `file_search_call`. A tool without a price is free; nothing is
  invented. Usage is stored in `RequestLog.toolUsage`.
- **Video**: `seconds x perSecondPrice x multiplier`, charged at job creation. A video model without a per-second
  price is refused. Failed jobs are refunded once (`REFUND` ledger entry, `ApiKey.spent` reduced).
- **Files** storage is free unless the admin creates a hidden model with slug `files` and a `requestPrice`.

### Batch API discount order

1. Token part x long-context factor.
2. x (1 - discount). The customer side uses `Model.batchDiscountPct` (null = 50). Our cost uses
   `ModelRoute.batchCostDiscountPct` (default 50).
3. Add the flat part and server tools, **undiscounted**.
4. x multiplier (customer price only).

The official price of a batch result is the vendor's own batch price: official list price with the 50% discount.

## Official price and savings snapshots

For every request the gateway computes `RequestLog.officialPrice`: the same usage priced at official prices
(`effectiveOfficial`). A unit without an official price is priced at what the customer pays for it, so its savings
are exactly 0. `price` and `officialPrice` are **written once** per request. Dashboards and "You saved $X" only sum
them, so changing prices later never rewrites history.

## Funds holds

Before any upstream call (`reserveFunds`) the gateway reserves the **worst-case** price:

```
hold      = price(estimated input tokens x 1.1, effective max output x choices, flat / per-image / per-second parts)
available = balance + creditLimit - minBalanceToCall - (open holds + settled-but-unflushed debits)
```

It is also checked against the key's remaining spend limit and the customer's remaining monthly limit.
- If it does not fit, the answer is **402 `insufficient_balance`** (or `spend_limit_reached`) in the native error
  shape, and **the upstream is never contacted**.
- If the client set an output limit (any spelling), the hold covers exactly that, capped by the model or route
  maximum. The client's limit itself is passed to the provider unchanged, even when it is above the catalog maximum
  (the provider accepts it or answers with its own error, exactly as when called directly).
- If the client set no limit, nothing is added to the request as long as the balance covers the model maximum (16384
  assumed when unknown). Only when it does not is the output clamped to what is affordable, written into the upstream
  request, never below 256 tokens (below 256 the answer is 402). This funds clamp is the only limit the gateway ever
  writes into a request; keep in-house accounts postpaid or well funded so long generations are never clamped.
- **Stream cutoff**: when the accrued cost of a stream clearly exceeds the hold (estimated at 4-5 characters per token,
  with 25% headroom when a limit is enforced and 50% when none is, so a full-length answer is never cut), the upstream is
  aborted and the stream ends
  with a native `insufficient_balance` error event. What was produced is metered. This is the gateway's one
  deliberate non-passthrough behaviour.
- When the request is logged, the hold is **settled** (it becomes a pending debit until the meter writer commits it)
  or **released**. Holds live in Redis (`hold:{userId}`, atomic Lua, per-hold expiry renewed by a heartbeat) or in
  memory. N concurrent requests can therefore never jointly overspend.
- Batches use one long-lived hold (30 h) for the whole batch. It is released after every result is metered.

Customers whose balance + credit limit is used up get 402 on the next request. That is how postpaid limits and
"suspend below -creditLimit" are enforced.

## Ledger

Every balance movement **except** per-request usage is a `LedgerEntry` with `balanceAfter`. Each one is written in
one transaction with `SELECT ... FOR UPDATE` on the user row (`src/server/billing/ledger.ts`, the only way to move a
balance). Per-request usage lives in `RequestLog.price` and is debited by the meter writer.

| Type | Source |
|---|---|
| `TOPUP` | Stripe top-up (idempotent on `paymentId`) |
| `AUTO_RECHARGE` | Off-session auto-recharge |
| `TRIAL_CREDIT` | Granted on email verification (or on first card when `requireCardForTrial`) |
| `REDEEM` | Redeem code |
| `ADJUSTMENT` | Admin "Promotional credit" or "Correction" (may be negative), or "Adjust balance" |
| `REFUND` | Admin "Refund" credit, a Stripe refund (debit), or a failed video job (credit) |
| `CHARGEBACK` | Stripe dispute (debit; the customer is suspended) |
| `POSTPAID_SETTLEMENT` | Postpaid balance charged to the card |
| `USAGE_CORRECTION` | Reserved for usage fixes |

After a commit the gateway's cached balance is invalidated.

## Stripe top-ups (prepaid, default)

- The customer adds a card (SetupIntent + Payment Element) and tops up any amount between `minTopup` (at least
  $0.50) and `maxTopup`. With a saved card this is a PaymentIntent on that card. Without one it goes through Stripe
  Checkout.
- The webhook (`payment_intent.succeeded` / `checkout.session.completed`) credits the balance exactly once.
  Failed or canceled intents and expired checkouts mark the payment failed. Refunds debit the refunded delta
  (partial refunds supported). Disputes debit the amount and suspend the customer.
- `PENDING` payments older than 24 h are reconciled against Stripe by the hourly billing cron.
- Without Stripe keys, billing shows "Stripe not configured". Redeem codes and admin credits still work.

## Auto-recharge

The customer enables it with a threshold (default $5) and an amount (default $20). After a request pushes the balance
below the threshold, the meter writer calls `triggerAutoRecharge` (the hourly cron also sweeps candidates). It runs
an off-session PaymentIntent for the amount. Guards: a per-user lock, at most one in flight, at most
`autoRechargeMaxPerDay` (3) per 24 h, and at least 5 minutes between attempts. After **3 consecutive failures**
auto-recharge is switched off and the customer is emailed.

**Low-balance email**: sent when the balance drops below `lowBalanceAlertAt` (or the auto-recharge threshold), at
most once per 24 h. It is skipped when auto-recharge will handle it silently. The global switch is `lowBalanceEmail`.

## Postpaid

An admin sets the customer's billing mode to `POSTPAID` and a `creditLimit` > 0, so the balance may go negative down
to `-creditLimit`. The hourly billing cron charges an outstanding negative balance of at least $1 to the saved card,
at most once per 20 h per customer (`POSTPAID_SETTLEMENT`). A failure marks the payment failed and emails the
customer. New requests are refused once the credit limit is used up.

## Redeem codes and trial credit

- Admins generate codes in **Admin > Billing > Codes**: amount, count, max uses, expiry, note, optional prefix. The
  alphabet avoids 0/O/1/I/L. Each customer can redeem a code once. Codes can be disabled or deleted.
- `trialCredit` (default $0) is granted once when the customer verifies their email. With `requireCardForTrial` it is
  granted when the first card is attached instead.
