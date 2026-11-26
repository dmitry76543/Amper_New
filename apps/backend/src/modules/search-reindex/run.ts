import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import {
  acquireSyncLock,
  releaseSyncLock,
} from "../moysklad/sync-lock"
import {
  canStartSearchReindex,
  markSearchReindexError,
  markSearchReindexOk,
  markSearchReindexRunning,
  type SearchReindexTrigger,
  getSearchReindexState,
} from "./state"

type SearchModule = {
  reindex: (input?: {
    index?: string | string[]
    strategy?: "swap" | "in_place"
    filters?: Record<string, unknown>
  }) => Promise<{ job_id?: string; indexes?: string[] }>
}

const LOCK_KEY = "search-reindex"
/** Полный swap по ~12k товаров — запас по TTL */
const LOCK_TTL_MS = 90 * 60 * 1000

export type SearchReindexRunResult = {
  ok: boolean
  message: string
  state: ReturnType<typeof getSearchReindexState>
}

/**
 * Полная пересборка поискового индекса product (strategy: swap).
 * Не трогает МойСклад и каталог Medusa — только search index.
 */
export async function runProductSearchReindex(
  container: MedusaContainer,
  trigger: SearchReindexTrigger
): Promise<SearchReindexRunResult> {
  if (!canStartSearchReindex()) {
    return {
      ok: false,
      message: "Переиндексация уже выполняется",
      state: getSearchReindexState(),
    }
  }

  const lock = await acquireSyncLock(container, LOCK_KEY, LOCK_TTL_MS)
  if (!lock) {
    return {
      ok: false,
      message: "Не удалось взять блокировку переиндексации (уже занята)",
      state: getSearchReindexState(),
    }
  }

  const started = markSearchReindexRunning(trigger)
  const startedAt = started.startedAt || new Date().toISOString()

  try {
    const search = container.resolve(Modules.SEARCH) as SearchModule
    const result = await search.reindex({
      index: "product",
      strategy: "swap",
    })
    const state = markSearchReindexOk({
      startedAt,
      indexes: result.indexes,
      jobId: result.job_id,
    })
    console.log("[search-reindex] ok:", {
      trigger,
      durationMs: state.durationMs,
      indexes: state.indexes,
      jobId: state.jobId,
    })
    return {
      ok: true,
      message: `Поисковый индекс пересобран (${(state.indexes || ["product"]).join(", ")})`,
      state,
    }
  } catch (error) {
    const message = (error as Error).message || String(error)
    const state = markSearchReindexError(startedAt, message)
    console.error("[search-reindex] failed:", message)
    return {
      ok: false,
      message: `Ошибка переиндексации: ${message}`,
      state,
    }
  } finally {
    await releaseSyncLock(container, LOCK_KEY, lock)
  }
}

/**
 * Запуск в фоне для Admin API (сразу 202, статус через GET).
 */
export async function startProductSearchReindexBackground(
  container: MedusaContainer,
  trigger: SearchReindexTrigger
): Promise<SearchReindexRunResult> {
  if (!canStartSearchReindex()) {
    return {
      ok: false,
      message: "Переиндексация уже выполняется",
      state: getSearchReindexState(),
    }
  }

  const lock = await acquireSyncLock(container, LOCK_KEY, LOCK_TTL_MS)
  if (!lock) {
    return {
      ok: false,
      message: "Не удалось взять блокировку переиндексации (уже занята)",
      state: getSearchReindexState(),
    }
  }

  const started = markSearchReindexRunning(trigger)
  const startedAt = started.startedAt || new Date().toISOString()

  void (async () => {
    try {
      const search = container.resolve(Modules.SEARCH) as SearchModule
      const result = await search.reindex({
        index: "product",
        strategy: "swap",
      })
      markSearchReindexOk({
        startedAt,
        indexes: result.indexes,
        jobId: result.job_id,
      })
      console.log("[search-reindex] ok:", {
        trigger,
        indexes: result.indexes,
        jobId: result.job_id,
      })
    } catch (error) {
      const message = (error as Error).message || String(error)
      markSearchReindexError(startedAt, message)
      console.error("[search-reindex] failed:", message)
    } finally {
      await releaseSyncLock(container, LOCK_KEY, lock)
    }
  })()

  return {
    ok: true,
    message:
      "Пересборка поискового индекса запущена в фоне. Статус обновляется на этой странице.",
    state: getSearchReindexState(),
  }
}
