import type { MedusaContainer } from "@medusajs/framework/types"
import { MOYSKLAD_MODULE } from "../modules/moysklad"
import type MoySkladModuleService from "../modules/moysklad/service"
import {
  getSyncState,
  markStockSyncError,
  markStockSyncOk,
  shouldRunStockSync,
} from "../modules/moysklad/sync-state"
import { applyMoyskladStockRows } from "../modules/moysklad/stock-sync"
import {
  acquireSyncLock,
  releaseSyncLock,
} from "../modules/moysklad/sync-lock"
import type { MoySkladStockRow } from "../modules/moysklad/types"

/**
 * Лёгкая страховка остатков: каждые N минут (по умолчанию 2) или сразу
 * после webhook. При ошибке курсор не двигаем — диапазон повторится.
 */
export default async function moyskladStockSyncJob(
  container: MedusaContainer
) {
  if (!shouldRunStockSync()) return

  const lock = await acquireSyncLock(container, "stock", 10 * 60 * 1000)
  if (!lock) return

  const startedMs = Date.now()
  const startedAt = new Date(startedMs).toISOString()
  try {
    const state = getSyncState()
    const moysklad: MoySkladModuleService = container.resolve(MOYSKLAD_MODULE)
    const { storeId } = await moysklad.resolveDefaults()
    const client = moysklad.getClient()

    // Небольшой запас назад, чтобы не пропустить граничные изменения
    const overlapMs = 60_000
    const sinceIso = state.lastStockSyncAt
      ? new Date(
          new Date(state.lastStockSyncAt).getTime() - overlapMs
        ).toISOString()
      : undefined

    let rows: MoySkladStockRow[]
    try {
      rows = await client.listChangedFreeStock(storeId, sinceIso)
    } catch (error) {
      // Первый запуск или недоступность changedSince — полный склад
      console.warn(
        "[job] moysklad stock changedSince fallback:",
        (error as Error).message
      )
      try {
        rows = await client.listStockByStore(storeId)
      } catch {
        rows = await client.listStockAll()
      }
    }

    // Краткий отчёт отдаёт freeStock — нормализуем к stock/reserve для helper
    const normalized = rows.map((row) => ({
      ...row,
      stock: Number.isFinite(Number(row.freeStock))
        ? Number(row.freeStock)
        : Number(row.stock ?? 0),
      freeStock: Number.isFinite(Number(row.freeStock))
        ? Number(row.freeStock)
        : Number(row.stock ?? 0),
      reserve: 0,
    }))

    const result = await applyMoyskladStockRows(container, normalized)
    const durationMs = Date.now() - startedMs
    if (result.errors.length) {
      markStockSyncError(result.errors.slice(0, 3).join("; "), {
        durationMs,
        startedAt,
        summary: "Страховка остатков",
      })
      console.error("[job] moysklad stock sync partial errors:", result.errors)
      return
    }

    // 2-мин страховка: в журнал только ошибки (ниже / markStockSyncError).
    // Успех — шум; «жива ли» видно на странице МойСклад.
    markStockSyncOk({
      durationMs,
      startedAt,
      log: false,
    })
    console.log("[job] moysklad stock sync:", {
      changed: normalized.length,
      durationMs,
      ...result,
    })
  } catch (error) {
    markStockSyncError((error as Error).message, {
      durationMs: Date.now() - startedMs,
      startedAt,
    })
    console.error(
      "[job] moysklad stock sync failed:",
      (error as Error).message
    )
  } finally {
    await releaseSyncLock(container, "stock", lock)
  }
}

export const config = {
  name: "moysklad-stock-sync",
  // Каждую минуту: сам job смотрит stockIntervalMinutes / webhook-флаг
  schedule: "* * * * *",
}
