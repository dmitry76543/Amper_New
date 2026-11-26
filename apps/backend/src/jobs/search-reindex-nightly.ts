import type { MedusaContainer } from "@medusajs/framework/types"
import { runProductSearchReindex } from "../modules/search-reindex/run"
import {
  getSearchReindexState,
  saveSearchReindexState,
} from "../modules/search-reindex/state"

/**
 * Ночная пересборка поискового индекса — отдельно от ночного синка МойСклад (час 3).
 * По умолчанию час 5 (MOYSKLAD_SEARCH_REINDEX_HOUR).
 */
export default async function searchReindexNightlyJob(
  container: MedusaContainer
) {
  const state = getSearchReindexState()
  const hour = state.nightlyHour
  const now = new Date()
  if (now.getHours() !== hour || now.getMinutes() > 1) return

  const today = now.toISOString().slice(0, 10)
  if (state.nightlyDoneDate === today) return
  if (state.status === "running") return

  const result = await runProductSearchReindex(container, "schedule")
  if (result.ok) {
    saveSearchReindexState({ nightlyDoneDate: today })
  }
  console.log("[job] search-reindex nightly:", result.message, {
    durationMs: result.state.durationMs,
    indexes: result.state.indexes,
  })
}

export const config = {
  name: "search-reindex-nightly",
  schedule: "* * * * *",
}
