// STUB created by lead — Gateway agent implements, keeping these signatures.
export type HealthResult = { ok: boolean; latencyMs: number | null; error?: string };

export async function checkProviderKey(providerKeyId: string): Promise<HealthResult> {
  void providerKeyId;
  return { ok: false, latencyMs: null, error: "not implemented" };
}

export async function checkProvider(providerId: string): Promise<HealthResult[]> {
  void providerId;
  return [];
}

export async function runAllHealthChecks(): Promise<{ checked: number; failed: number }> {
  return { checked: 0, failed: 0 };
}
