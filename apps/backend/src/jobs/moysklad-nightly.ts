import type { MedusaContainer } from "@medusajs/framework/types"
import { syncMoyskladCatalogWorkflow } from "../workflows/sync-moysklad-catalog"
import {
  canStartSync,
  getSyncState,
  markSyncError,
  markSyncOk,
  markSyncRunning,
  saveSyncState,
} from "../modules/moysklad/sync-state"
import {
  acquireSyncLock,
  releaseSyncLock,
} from "../modules/moysklad/sync-lock"

/** Час ночного полного контроля (серверное локальное время) */
const NIGHTLY_HOUR = Number(process.env.MOYSKLAD_NIGHTLY_HOUR || 3)

/**
 * Полный контрольный прогон раз в сутки: архивы, категории, фото, остатки.
 * Окно запуска — минута 0–1 указанного часа.
 */
export default async function moyskladNightlyJob(container: MedusaContainer) {
  const now = new Date()
  if (now.getHours() !== NIGHTLY_HOUR || now.getMinutes() > 1) return

  const today = now.toISOString().slice(0, 10)
  const state = getSyncState()
  if (state.nightlyDoneDate === today) return
  if (!canStartSync()) return

  const lock = await acquireSyncLock(container, "catalog", 90 * 60 * 1000)
  if (!lock) return

  const started = markSyncRunning("schedule")
  try {
    const { result } = await syncMoyskladCatalogWorkflow(container).run({})
    markSyncOk("schedule", started.startedAt, (result || {}) as never)
    saveSyncState({ nightlyDoneDate: today })
    console.log("[job] moysklad nightly full sync:", result)
  } catch (error) {
    markSyncError("schedule", started.startedAt, (error as Error).message)
    console.error(
      "[job] moysklad nightly sync failed:",
      (error as Error).message
    )
  } finally {
    await releaseSyncLock(container, "catalog", lock)
  }
}

export const config = {
  name: "moysklad-nightly",
  schedule: "* * * * *",
}
