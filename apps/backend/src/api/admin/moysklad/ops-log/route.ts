import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import {
  listOpsLog,
  type OpsLogKind,
} from "../../../../modules/moysklad/ops-log"

/**
 * GET /admin/moysklad/ops-log — журнал запусков (каталог / остатки / поиск).
 * Query: limit (1–500), kind (catalog|stock|search-reindex)
 */
export const GET = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const limitRaw = Number(req.query?.limit)
  const kindRaw = String(req.query?.kind || "")
  const kind = (
    ["catalog", "stock", "force-align", "search-reindex"].includes(kindRaw)
      ? kindRaw
      : undefined
  ) as OpsLogKind | undefined

  const entries = listOpsLog({
    limit: Number.isFinite(limitRaw) ? limitRaw : 100,
    kind,
  })

  res.json({
    entries,
    retentionDays: 30,
    maxEntries: 2000,
  })
}
