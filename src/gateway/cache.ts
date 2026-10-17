// STUB created by lead — Gateway agent implements the hot-path config cache (PLAN §9b), keeping these exports.
// Call invalidateGatewayConfig() after ANY admin/customer mutation of providers, provider keys, models, routes,
// groups, settings, users (status/group/multiplier/limits/balance) or API keys. Must never throw.
export type InvalidateScope = "all" | "providers" | "models" | "groups" | "settings" | "users" | "apiKeys";

export async function invalidateGatewayConfig(scope: InvalidateScope = "all", id?: string): Promise<void> {
  void scope;
  void id;
}
