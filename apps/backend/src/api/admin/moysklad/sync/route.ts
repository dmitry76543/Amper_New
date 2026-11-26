import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import {
  syncMoyskladCatalogWorkflow,
  syncMoyskladStockWorkflow,
} from "../../../../workflows/sync-moysklad-catalog"
import {
  canStartSync,
  getSyncState,
  markSyncError,
  markSyncOk,
  markSyncRunning,
  saveSyncState,
  computeNextDueAt,
} from "../../../../modules/moysklad/sync-state"
import {
  acquireSyncLock,
  releaseSyncLock,
} from "../../../../modules/moysklad/sync-lock"

function publicState() {
  const sync = getSyncState()
  if (!sync.nextDueAt && sync.finishedAt) {
    sync.nextDueAt = computeNextDueAt(sync.finishedAt, sync.intervalMinutes)
  } else if (!sync.nextDueAt && sync.status !== "running") {
    sync.nextDueAt = computeNextDueAt(undefined, sync.intervalMinutes)
  }
  const startedMs = sync.startedAt ? new Date(sync.startedAt).getTime() : NaN
  const runningForMs =
    sync.status === "running" && Number.isFinite(startedMs)
      ? Math.max(0, Date.now() - startedMs)
      : undefined
  return {
    ...sync,
    runningForMs,
  }
}

/**
 * GET /admin/moysklad/sync — статус + настройки интервалов.
 */
export const GET = async (
  _req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  res.json({ sync: publicState() })
}

/**
 * POST /admin/moysklad/sync — ручной запуск / настройки.
 */
export const POST = async (
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse
) => {
  const body = (req.body || {}) as {
    intervalMinutes?: number
    stockIntervalMinutes?: number
    action?: "sync" | "settings" | "force-align"
  }

  if (
    body.action === "settings" ||
    ((body.intervalMinutes != null || body.stockIntervalMinutes != null) &&
      body.action !== "sync" &&
      body.action !== "force-align")
  ) {
    const patch: {
      intervalMinutes?: number
      stockIntervalMinutes?: number
      nextDueAt?: string
    } = {}
    if (body.intervalMinutes != null) {
      patch.intervalMinutes = body.intervalMinutes
      patch.nextDueAt = computeNextDueAt(
        getSyncState().finishedAt || new Date().toISOString(),
        body.intervalMinutes
      )
    }
    if (body.stockIntervalMinutes != null) {
      patch.stockIntervalMinutes = body.stockIntervalMinutes
    }
    if (
      patch.intervalMinutes == null &&
      patch.stockIntervalMinutes == null
    ) {
      res.status(400).json({
        message: "Укажите intervalMinutes или stockIntervalMinutes",
      })
      return
    }
    const sync = saveSyncState(patch)
    res.json({
      message: `Каталог: каждые ${sync.intervalMinutes} мин · остатки: каждые ${sync.stockIntervalMinutes} мин`,
      sync: publicState(),
    })
    return
  }

  if (!canStartSync()) {
    res.status(409).json({
      message: "Синхронизация уже выполняется",
      sync: publicState(),
    })
    return
  }

  const forceAlign = body.action === "force-align"
  const scope = req.scope
  const lockKey = forceAlign ? "stock" : "catalog"
  const lock = await acquireSyncLock(
    scope as never,
    lockKey,
    forceAlign ? 15 * 60 * 1000 : 90 * 60 * 1000
  )
  if (!lock) {
    res.status(409).json({
      message: "Синхронизация уже выполняется",
      sync: publicState(),
    })
    return
  }

  const started = markSyncRunning("manual")

  res.status(202).json({
    message: forceAlign
      ? "Принудительное выравнивание по МойСклад запущено (резервы + остатки)"
      : "Синхронизация с МойСклад запущена в фоне",
    sync: started,
  })

  void (async () => {
    try {
      let reservationsCleared = 0
      if (forceAlign) {
        const { Modules } = await import("@medusajs/framework/utils")
        const inventoryModule = scope.resolve(Modules.INVENTORY) as {
          listReservationItems?: (
            filters: Record<string, unknown>,
            config?: { take?: number; skip?: number }
          ) => Promise<Array<{ id: string }>>
          deleteReservationItems?: (ids: string[]) => Promise<unknown>
        }
        if (
          typeof inventoryModule.listReservationItems === "function" &&
          typeof inventoryModule.deleteReservationItems === "function"
        ) {
          for (let skip = 0; ; skip += 200) {
            const page = await inventoryModule.listReservationItems(
              {},
              { take: 200, skip }
            )
            if (!page.length) break
            await inventoryModule.deleteReservationItems(page.map((r) => r.id))
            reservationsCleared += page.length
            if (page.length < 200) break
          }
        }
        console.log(
          `[admin] moysklad force-align: снято резервов ${reservationsCleared}`
        )
      }

      const { result } = forceAlign
        ? await syncMoyskladStockWorkflow(scope).run({})
        : await syncMoyskladCatalogWorkflow(scope).run({})
      const merged = {
        ...(result || {}),
        reservationsCleared: forceAlign ? reservationsCleared : undefined,
      }
      markSyncOk("manual", started.startedAt, merged as never, {
        kind: forceAlign ? "force-align" : "catalog",
        summary: forceAlign
          ? "Выравнивание по МойСклад"
          : "Синхронизация каталога",
      })
      console.log(
        forceAlign
          ? "[admin] moysklad force-align ok:"
          : "[admin] moysklad sync ok:",
        merged
      )
    } catch (e) {
      markSyncError("manual", started.startedAt, (e as Error).message, {
        kind: forceAlign ? "force-align" : "catalog",
        summary: forceAlign
          ? "Выравнивание по МойСклад"
          : "Синхронизация каталога",
      })
      console.error("[admin] moysklad sync failed:", (e as Error).message)
    } finally {
      await releaseSyncLock(scope as never, lockKey, lock)
    }
  })()
}
