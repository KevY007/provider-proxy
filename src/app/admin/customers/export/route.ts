import { requireAdminForAction } from "@/lib/auth/session";
import { AuthError } from "@/lib/auth/types";
import { parseCustomerListParams } from "@/server/admin/customers-calc";
import { exportCustomers } from "@/server/admin/customers-queries";
import { csvResponse, toCsv } from "@/server/analytics/csv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireAdminForAction();
  } catch (err) {
    if (err instanceof AuthError) return new Response(err.code === "unauthenticated" ? "Unauthorized" : "Forbidden", { status: err.code === "unauthenticated" ? 401 : 403 });
    throw err;
  }
  const params = parseCustomerListParams(new URL(req.url).searchParams);
  const rows = await exportCustomers(params);
  const csv = toCsv(rows, [
    { key: "id" },
    { key: "email" },
    { key: "name" },
    { key: "status" },
    { key: "role" },
    { key: "emailVerified", header: "email_verified" },
    { key: "groupName", header: "group" },
    { key: "balance" },
    { key: "creditLimit", header: "credit_limit" },
    { key: "billingMode", header: "billing_mode" },
    { key: "spend30d", header: "spend_30d" },
    { key: "requests30d", header: "requests_30d" },
    { key: "lastActive", header: "last_active" },
    { key: "createdAt", header: "created_at" },
  ]);
  return csvResponse(csv, `customers-${new Date().toISOString().slice(0, 10)}.csv`);
}
