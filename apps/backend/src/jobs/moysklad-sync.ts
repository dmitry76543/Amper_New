import type { MedusaContainer } from "@medusajs/framework/types"
import { syncMoyskladCatalogWorkflow } from "../workflows/sync-moysklad-catalog"
import { Modules } from "@medusajs/framework/utils"
import { MOYSKLAD_MODULE } from "../modules/moysklad"
import type MoySkladModuleService from "../modules/moysklad/service"
import {
  markSyncError,
  markSyncOk,
  markSyncRunning,
  shouldRunScheduledSync,
} from "../modules/moysklad/sync-state"
import {
  acquireSyncLock,
  releaseSyncLock,
} from "../modules/moysklad/sync-lock"

/**
 * Тик каждую минуту: если пора по intervalMinutes — гоняем умный синк.
 * Интервал меняется в Admin → МойСклад (без правки кода).
 */
export default async function moyskladSyncJob(container: MedusaContainer) {
  if (!shouldRunScheduledSync()) {
    return
  }

  const lock = await acquireSyncLock(container, "catalog", 90 * 60 * 1000)
  if (!lock) return

  const started = markSyncRunning("schedule")
  try {
    const { result } = await syncMoyskladCatalogWorkflow(container).run({})
    markSyncOk("schedule", started.startedAt, (result || {}) as never)
    console.log("[job] moysklad catalog sync:", result)
  } catch (e) {
    markSyncError("schedule", started.startedAt, (e as Error).message)
    console.error("[job] moysklad catalog sync failed:", (e as Error).message)
  } finally {
    await releaseSyncLock(container, "catalog", lock)
  }

  // Подтягиваем статусы заказов, у которых есть moysklad_order_id
  try {
    const moysklad: MoySkladModuleService = container.resolve(MOYSKLAD_MODULE)
    const orderModule = container.resolve(Modules.ORDER)
    const client = moysklad.getClient()

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const updated = await client.listCustomerOrdersUpdatedSince(since)

    for (const msOrder of updated) {
      const orders = await orderModule.listOrders(
        { metadata: { moysklad_order_id: msOrder.id } } as never,
        { take: 1 }
      )
      let order = orders[0]
      if (!order && msOrder.externalCode) {
        try {
          order = await orderModule.retrieveOrder(msOrder.externalCode)
        } catch {
          order = undefined as never
        }
      }
      if (!order) continue

      const stateName = msOrder.state?.name || ""
      const meta = (order.metadata || {}) as Record<string, string>
      if (meta.moysklad_state === stateName) continue

      await orderModule.updateOrders(order.id, {
        metadata: {
          ...meta,
          moysklad_state: stateName,
          moysklad_synced_at: new Date().toISOString(),
        },
      })
    }
  } catch (e) {
    console.error(
      "[job] moysklad order status sync failed:",
      (e as Error).message
    )
  }
}

export const config = {
  name: "moysklad-sync",
  // Каждую минуту проверяем, не пора ли по настройке из Admin
  schedule: "* * * * *",
}
