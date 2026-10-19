/**
 * Admin "Quick start" checklist state (pure). Each step auto-ticks from DB state:
 * add provider key -> test it -> add/enable models -> set pricing -> first customer request.
 */
export interface QuickStartInput {
  /** ACTIVE provider keys on ACTIVE providers. */
  activeKeys: number;
  /** Providers (or keys) that have been health-checked / tested at least once. */
  testedProviders: number;
  /** ACTIVE models that have at least one enabled route. */
  liveModels: number;
  /** Of those, models with a customer price above zero. */
  pricedModels: number;
  /** Successful requests from real customers (not admins). */
  customerRequests: number;
}

export type QuickStartStepId = "key" | "test" | "models" | "pricing" | "request";

export interface QuickStartStep {
  id: QuickStartStepId;
  title: string;
  description: string;
  href: string;
  cta: string;
  done: boolean;
}

export interface QuickStartState {
  steps: QuickStartStep[];
  doneCount: number;
  total: number;
  allDone: boolean;
  next: QuickStartStep | null;
}

export function deriveQuickStart(i: QuickStartInput): QuickStartState {
  const steps: QuickStartStep[] = [
    { id: "key", title: "Add a provider key", description: "Paste an API key from OpenAI, Anthropic, Google or any other provider.", href: "/admin/providers", cta: "Add provider key", done: i.activeKeys > 0 },
    { id: "test", title: "Test the key", description: "Press Test next to the key to make sure it works.", href: "/admin/providers", cta: "Test it", done: i.testedProviders > 0 },
    { id: "models", title: "Add and enable models", description: "Pick the real models you want to sell. We prefill the official prices.", href: "/admin/models/new", cta: "Add a model", done: i.liveModels > 0 },
    { id: "pricing", title: "Set your pricing", description: "Choose a pricing rule so customers see what they save versus the official price.", href: "/admin/models", cta: "Review pricing", done: i.pricedModels > 0 },
    { id: "request", title: "Get the first customer request", description: "Invite a customer or try the demo account's API key.", href: "/admin/customers", cta: "Open customers", done: i.customerRequests > 0 },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return { steps, doneCount, total: steps.length, allDone: doneCount === steps.length, next: steps.find((s) => !s.done) ?? null };
}
