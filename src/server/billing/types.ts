/** Serializable shapes passed from server components to the billing client components. */

export interface LedgerRow {
  id: string;
  type: string;
  /** Signed USD as a decimal string. */
  amount: string;
  balanceAfter: string;
  description: string;
  paymentId: string | null;
  createdAt: string;
  /** Admin views only. */
  userId?: string;
  userEmail?: string;
  createdById?: string | null;
}

export interface PaymentRow {
  id: string;
  amount: string;
  status: string;
  kind: string;
  failureReason: string | null;
  receiptUrl: string | null;
  createdAt: string;
  /** Admin views only. */
  userId?: string;
  userEmail?: string;
  stripePaymentIntentId?: string | null;
}

export interface RedeemCodeRow {
  id: string;
  code: string;
  amount: string;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
  status: "active" | "expired" | "exhausted";
}

export interface SavedCardRow {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
}
