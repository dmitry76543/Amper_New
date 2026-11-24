import type { ExecArgs } from "@medusajs/framework/types"
import { syncAllMoyskladStock } from "../modules/moysklad/stock-sync"

/** Быстро подтянуть остатки МойСклад → inventory levels */
export default async function syncStockOnly({ container }: ExecArgs) {
  const result = await syncAllMoyskladStock(container)
  console.log(result)
}
