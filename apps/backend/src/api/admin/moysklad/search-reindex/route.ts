import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import { startProductSearchReindexBackground } from "../../../../modules/search-reindex/run"
import { getSearchReindexState } from "../../../../modules/search-reindex/state"

function publicState() {
  const search = getSearchReindexState()
  const startedMs = search.startedAt ? new Date(search.startedAt).getTime() : NaN
  const runningForMs =
    search.status === "running" && Number.isFinite(startedMs)
      ? Math.max(0, Date.now() - startedMs)
      : undefined
  return { ...search, runningForMs }
}

/**
 * GET /admin/moysklad/search-reindex — статус последней переиндексации поиска.
 */
export const GET = async (
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  res.json({ searchReindex: publicState() })
}

/**
 * POST /admin/moysklad/search-reindex — ручной запуск в фоне.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const result = await startProductSearchReindexBackground(req.scope, "manual")
  res.status(result.ok ? 202 : 409).json({
    message: result.message,
    searchReindex: publicState(),
  })
}
