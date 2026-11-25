import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { MOYSKLAD_MODULE } from "../../../modules/moysklad"
import type MoySkladModuleService from "../../../modules/moysklad/service"
import { requestStockSync } from "../../../modules/moysklad/sync-state"

const STOCK_EVENT =
  /customerorder|demand|supply|move|inventory|loss|enter|retailsalesreturn|salesreturn|purchasereturn|factureout|facturein|retaildemand|status/i

const PRODUCT_EVENT = /product|variant|bundle|service|productfolder/i

/**
 * Webhook / ручной триггер от МойСклад.
 * POST /hooks/moysklad
 * Заголовок X-Amper-Webhook-Secret (опционально, если задан MOYSKLAD_WEBHOOK_SECRET).
 *
 * Складские события только помечают остатки — полный каталог не гоняем.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const moysklad: MoySkladModuleService = req.scope.resolve(MOYSKLAD_MODULE)
  const secret = moysklad.getOptions().webhookSecret
  if (secret) {
    const header = req.headers["x-amper-webhook-secret"]
    if (header !== secret) {
      res.status(401).json({ message: "Unauthorized" })
      return
    }
  }

  const body = (req.body || {}) as {
    events?: Array<{ meta?: { type?: string }; action?: string }>
    type?: string
  }

  const types = (body.events || [])
    .map((e) => e.meta?.type || e.action || "")
    .concat(body.type || "")
    .filter(Boolean)
    .map((t) => String(t))

  const orderRelated = types.some((t) =>
    /customerorder|demand|status/i.test(t)
  )
  const stockRelated = types.some((t) => STOCK_EVENT.test(t))
  const productRelated = types.some((t) => PRODUCT_EVENT.test(t))

  if (orderRelated) {
    try {
      const orderModule = req.scope.resolve(Modules.ORDER)
      const client = moysklad.getClient()
      const since = new Date(Date.now() - 2 * 60 * 60 * 1000)
      const updated = await client.listCustomerOrdersUpdatedSince(since)
      for (const msOrder of updated) {
        if (!msOrder.externalCode) continue
        try {
          const order = await orderModule.retrieveOrder(msOrder.externalCode)
          const meta = (order.metadata || {}) as Record<string, string>
          await orderModule.updateOrders(order.id, {
            metadata: {
              ...meta,
              moysklad_order_id: msOrder.id,
              moysklad_state: msOrder.state?.name || meta.moysklad_state || "",
              moysklad_synced_at: new Date().toISOString(),
            },
          })
        } catch {
          // заказ не из нашей витрины
        }
      }
    } catch (e) {
      res.status(500).json({ message: (e as Error).message })
      return
    }
  }

  if (stockRelated || orderRelated) {
    requestStockSync()
  }

  // Карточки/папки — только метка «нужен каталог» через обычный интервал;
  // полный sync из webhook больше не запускаем (блокировал бы backend).
  res.status(200).json({
    ok: true,
    mode: stockRelated || orderRelated ? "stock-marked" : "ack",
    productRelated,
  })
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const moysklad: MoySkladModuleService = req.scope.resolve(MOYSKLAD_MODULE)
  try {
    const ping = await moysklad.ping()
    const defaults = await moysklad.resolveDefaults()
    res.status(200).json({ ok: true, ping, defaults })
  } catch (e) {
    res.status(500).json({ ok: false, message: (e as Error).message })
  }
}
