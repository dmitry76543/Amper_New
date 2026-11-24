import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import {
  enqueueOrderExport,
  processOrderExport,
} from "../modules/moysklad/order-export"

/**
 * Сразу ставим заказ в постоянную очередь и пробуем доставить в МойСклад.
 * Если API недоступен, минутный job продолжит попытки.
 */
export default async function orderPlacedMoyskladHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  // Барьер: без явного разрешения не трогаем МС (и контрагентов тоже)
  if (process.env.MOYSKLAD_ALLOW_WRITES !== "true") {
    console.log(
      `Заказ ${data.id}: выгрузка в МойСклад пропущена (MOYSKLAD_ALLOW_WRITES≠true)`
    )
    return
  }

  const entry = await enqueueOrderExport(container, data.id)
  if (entry.status === "completed") return
  try {
    const created = await processOrderExport(container, entry)
    console.log(`Заказ ${data.id} → МойСклад ${created.name} (${created.id})`)
  } catch (error) {
    console.error(
      `Заказ ${data.id} оставлен в очереди МойСклад:`,
      (error as Error).message
    )
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
