import type { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { MOYSKLAD_MODULE } from "."
import type MoySkladModuleService from "./service"

const MAX_ATTEMPTS = 20

/** Ошибки данных не исправятся повтором без вмешательства */
function isPermanentError(message: string): boolean {
  return (
    /MOYSKLAD_API_TOKEN не задан/i.test(message) ||
    /запись запрещена/i.test(message) ||
    /МойСклад API (400|401|403|404|409|422)/i.test(message) ||
    /нет связи с товаром МойСклад/i.test(message)
  )
}

function nextAttemptAt(attempts: number): Date {
  const minutes = Math.min(60, Math.max(1, 2 ** Math.min(attempts - 1, 6)))
  return new Date(Date.now() + minutes * 60_000)
}

/**
 * Идемпотентно создаёт заказ в МойСклад.
 * Сначала ищет externalCode, поэтому обрыв после ответа API не создаст дубль.
 */
export async function exportOrderToMoysklad(
  container: MedusaContainer,
  orderId: string
): Promise<{ id: string; name: string }> {
  const orderModule = container.resolve(Modules.ORDER)
  const moysklad: MoySkladModuleService = container.resolve(MOYSKLAD_MODULE)
  const client = moysklad.getClient()
  const { organizationId, storeId } = await moysklad.resolveDefaults()

  const order = await orderModule.retrieveOrder(orderId, {
    relations: ["items", "shipping_address", "billing_address"],
  })
  const metadata = (order.metadata || {}) as Record<string, string>
  if (metadata.moysklad_order_id) {
    return {
      id: metadata.moysklad_order_id,
      name: metadata.moysklad_order_name || metadata.moysklad_order_id,
    }
  }

  const existing = await client.findCustomerOrderByExternalCode(order.id)
  if (existing) {
    await orderModule.updateOrders(order.id, {
      metadata: {
        ...metadata,
        moysklad_order_id: existing.id,
        moysklad_order_name: existing.name,
      },
    })
    return existing
  }

  const email =
    order.email ||
    (order.shipping_address as { email?: string } | undefined)?.email ||
    `guest-${order.id}@amper.local`
  const name =
    [order.shipping_address?.first_name, order.shipping_address?.last_name]
      .filter(Boolean)
      .join(" ") || email

  let agent = await client.findCounterpartyByEmail(email)
  if (!agent) {
    agent = await client.createCounterparty({
      name,
      email,
      phone: order.shipping_address?.phone || undefined,
    })
  }

  const rows = (order.items || []).map((item) => {
    const moyskladId = (item.metadata as Record<string, string> | null)
      ?.moysklad_id
    if (!moyskladId) {
      throw new Error(
        `Позиция «${item.title}» не имеет связи с товаром МойСклад`
      )
    }
    return {
      quantity: item.quantity,
      price: Math.round(Number(item.unit_price || 0)),
      discount: 0,
      vat: 0,
      assortment: {
        meta: {
          href: client.entityHref("product", moyskladId),
          type: "product",
          mediaType: "application/json",
        },
      },
      reserve: item.quantity,
    }
  })

  const created = await client.createCustomerOrder({
    name: `AMPER-${order.display_id || order.id}`,
    externalCode: order.id,
    organization: {
      meta: {
        href: client.entityHref("organization", organizationId),
        type: "organization",
        mediaType: "application/json",
      },
    },
    agent: {
      meta: {
        href: client.entityHref("counterparty", agent.id),
        type: "counterparty",
        mediaType: "application/json",
      },
    },
    store: {
      meta: {
        href: client.entityHref("store", storeId),
        type: "store",
        mediaType: "application/json",
      },
    },
    positions: { rows },
    description: `Заказ с сайта АМПЕР. Medusa ID: ${order.id}`,
  })

  await orderModule.updateOrders(order.id, {
    metadata: {
      ...metadata,
      moysklad_order_id: created.id,
      moysklad_order_name: created.name,
    },
  })
  return created
}

/** Ставит заказ в постоянную очередь, не создавая повторную запись */
export async function enqueueOrderExport(
  container: MedusaContainer,
  orderId: string
) {
  const service: MoySkladModuleService = container.resolve(MOYSKLAD_MODULE)
  const existing = await service.listMoyskladOrderOutboxes(
    { order_id: orderId },
    { take: 1 }
  )
  if (existing[0]) return existing[0]

  try {
    return await service.createMoyskladOrderOutboxes({
      order_id: orderId,
      status: "pending",
      attempts: 0,
    })
  } catch {
    const raced = await service.listMoyskladOrderOutboxes(
      { order_id: orderId },
      { take: 1 }
    )
    if (raced[0]) return raced[0]
    throw new Error(`Не удалось поставить заказ ${orderId} в очередь МойСклад`)
  }
}

/** Выполняет одну запись очереди и сохраняет результат/ошибку */
export async function processOrderExport(
  container: MedusaContainer,
  entry: {
    id: string
    order_id: string
    attempts: number
  }
) {
  const service: MoySkladModuleService = container.resolve(MOYSKLAD_MODULE)
  const attempts = Number(entry.attempts || 0) + 1
  await service.updateMoyskladOrderOutboxes({
    id: entry.id,
    status: "processing",
    attempts,
    locked_at: new Date(),
    last_error: null,
  })

  try {
    const created = await exportOrderToMoysklad(container, entry.order_id)
    await service.updateMoyskladOrderOutboxes({
      id: entry.id,
      status: "completed",
      moysklad_order_id: created.id,
      moysklad_order_name: created.name,
      next_attempt_at: null,
      locked_at: null,
      last_error: null,
    })
    return created
  } catch (error) {
    const message = (error as Error).message || "Неизвестная ошибка"
    const permanent = isPermanentError(message) || attempts >= MAX_ATTEMPTS
    await service.updateMoyskladOrderOutboxes({
      id: entry.id,
      status: permanent ? "failed" : "retry",
      next_attempt_at: permanent ? null : nextAttemptAt(attempts),
      locked_at: null,
      last_error: message,
    })
    throw error
  }
}
