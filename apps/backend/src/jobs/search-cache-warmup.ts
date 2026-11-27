import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ensureSearchCache,
  getSearchCacheStats,
} from "../modules/search-cache"

/**
 * Прогрев in-memory индекса поиска.
 *
 * Зачем job, а не loader: Medusa v2 не грузит src/loaders. Без прогрева
 * первый поиск после рестарта уходил бы в медленный SQL-путь.
 * Сам модуль идемпотентен (ensure проверяет готовность и возраст снимка),
 * поэтому минутный запуск — это дешёвый no-op в обычном состоянии.
 */
export default async function searchCacheWarmupJob(container: MedusaContainer) {
  const before = getSearchCacheStats()
  if (before.ready && (before.ageMs ?? Infinity) < 30 * 60 * 1000) return

  const snapshot = await ensureSearchCache(container)
  const after = getSearchCacheStats()
  console.log("[job] search-cache warmup:", {
    docs: snapshot?.docs.length ?? 0,
    buildMs: after.buildMs,
    source: after.source,
  })
}

export const config = {
  name: "search-cache-warmup",
  schedule: "* * * * *",
}
