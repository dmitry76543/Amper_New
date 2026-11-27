import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { invalidateSearchCache } from "../modules/search-cache"

/**
 * Инвалидация in-memory поиска при изменении товара.
 *
 * Без этого витрина показывала бы старые названия после правок в админке
 * и после синка МойСклад. Полная пересборка на 11.6k товаров — ~130 мс,
 * а окно тишины в модуле не даёт шторму событий (полный синк меняет всё)
 * пересобирать индекс на каждый товар.
 */
export default async function productSearchCacheInvalidate({
  container,
}: SubscriberArgs<{ id: string }>) {
  try {
    await invalidateSearchCache(container)
  } catch (error) {
    console.error(
      "[search-cache] invalidate failed:",
      (error as Error).message
    )
  }
}

export const config: SubscriberConfig = {
  event: ["product.created", "product.updated", "product.deleted"],
}
