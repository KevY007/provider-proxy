/**
 * Customer onboarding checklist state (pure). Each step auto-ticks from DB state:
 * verify email -> add balance -> create API key -> make first request.
 */
export interface OnboardingInput {
  emailVerified: boolean;
  /** Current balance in USD (string/number). */
  balance: string | number;
  /** True when the account ever received funds (top-up, redeem code, promotional credit, refund...). */
  everFunded: boolean;
  /** Non-playground, non-revoked API keys. */
  keyCount: number;
  /** Requests made with a real (non-playground) key. */
  requestCount: number;
}

export type OnboardingStepId = "verify" | "balance" | "key" | "request";

export interface OnboardingStep {
  id: OnboardingStepId;
  title: string;
  description: string;
  href: string;
  cta: string;
  done: boolean;
}

export interface OnboardingState {
  steps: OnboardingStep[];
  doneCount: number;
  total: number;
  allDone: boolean;
  /** First step not yet done. */
  next: OnboardingStep | null;
}

export function deriveOnboarding(input: OnboardingInput): OnboardingState {
  const hasBalance = input.everFunded || Number(input.balance) > 0;
  const steps: OnboardingStep[] = [
    { id: "verify", title: "Verify your email", description: "Keys only work once your email address is confirmed.", href: "/dashboard/settings", cta: "Open settings", done: input.emailVerified },
    { id: "balance", title: "Add balance", description: "Prepaid: top up by card or redeem a code. You only pay for what you use.", href: "/dashboard/billing", cta: "Add funds", done: hasBalance },
    { id: "key", title: "Create an API key", description: "One key and one base URL for every model.", href: "/dashboard/keys", cta: "Create key", done: input.keyCount > 0 },
    { id: "request", title: "Make your first request", description: "Try it in the Playground or copy a snippet from the key dialog.", href: "/dashboard/playground", cta: "Open playground", done: input.requestCount > 0 },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, total: steps.length, allDone: doneCount === steps.length, next: steps.find((s) => !s.done) ?? null };
}
