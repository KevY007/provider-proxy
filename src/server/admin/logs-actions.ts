"use server";

import { ActionFail, adminAction } from "./action";
import { getLogDetailData, type LogDetail } from "./logs-queries";

/** Full detail of one request log (staff only; includes internalError and stored bodies). */
export async function getLogDetail(id: string) {
  return adminAction<LogDetail>({}, async () => {
    if (!id || id.length > 100) throw new ActionFail("Invalid log id");
    const d = await getLogDetailData(id);
    if (!d) throw new ActionFail("Log not found (it may have been pruned)");
    return { data: d };
  });
}
