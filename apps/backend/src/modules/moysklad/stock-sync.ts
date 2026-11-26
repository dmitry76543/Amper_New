import type { MedusaContainer } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import { linkSalesChannelsToStockLocationWorkflow } from "@medusajs/medusa/core-flows"
import { MOYSKLAD_MODULE } from "."
import type MoySkladModuleService from "./service"
import type { MoySkladStockRow } from "./types"
import {
  calculateMedusaStockedQuantity,
  loadExportedLocalReservations,
} from "./stock-quantity"

/**
 * Применяет готовые строки остатков к Medusa.
 * Используется и полным workflow, и быстрым инкрементальным job.
 */
export async function applyMoyskladStockRows(
  container: MedusaContainer,
  stockRows: MoySkladStockRow[]
) {
  const moysklad: MoySkladModuleService = container.resolve(MOYSKLAD_MODULE)
  const productModule = container.resolve(Modules.PRODUCT)
  const inventoryModule = container.resolve(Modules.INVENTORY)
  const stockLocationModule = container.resolve(Modules.STOCK_LOCATION)
  const { storeId } = await moysklad.resolveDefaults()
  const client = moysklad.getClient()

  const locations = await stockLocationModule.listStockLocations({}, { take: 10 })
  let location = locations[0]
  if (!location) {
    location = await stockLocationModule.createStockLocations({
      name: "МойСклад",
      metadata: { moysklad_store_id: storeId },
    })
  }

  const salesChannelModule = container.resolve(Modules.SALES_CHANNEL)
  const channels = await salesChannelModule.listSalesChannels({}, { take: 1 })
  if (channels[0]) {
    await linkSalesChannelsToStockLocationWorkflow(container).run({
      input: { id: location.id, add: [channels[0].id], remove: [] },
    })
  }

  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const sql = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const exportedReservations = await loadExportedLocalReservations(sql)

  const variantByMsId = new Map<
    string,
    Awaited<ReturnType<typeof productModule.listProductVariants>>[0]
  >()
  for (let skip = 0; ; skip += 500) {
    const page = await productModule.listProductVariants(
      {},
      { take: 500, skip }
    )
    for (const variant of page) {
      const moyskladId = (
        variant.metadata as Record<string, string> | null
      )?.moysklad_id
      if (moyskladId) variantByMsId.set(moyskladId, variant)
    }
    if (page.length < 500) break
  }

  const inventoryByVariant = new Map<string, string>()
  const { data } = await query.graph({
    entity: "product_variant_inventory_item",
    fields: ["variant_id", "inventory_item_id"],
    filters: {},
  })
  for (const row of data as Array<{
    variant_id: string
    inventory_item_id: string
  }>) {
    inventoryByVariant.set(row.variant_id, row.inventory_item_id)
  }

  let stockUpdated = 0
  let stockUnchanged = 0
  const errors: string[] = []

  for (const row of stockRows) {
    try {
      const assortmentId =
        row.assortmentId || client.extractIdFromHref(row.meta?.href)
      if (!assortmentId) continue
      const variant = variantByMsId.get(assortmentId)
      if (!variant) continue

      let inventoryItemId = inventoryByVariant.get(variant.id)
      if (!inventoryItemId) {
        const items = await inventoryModule.listInventoryItems(
          { sku: variant.sku || undefined },
          { take: 1 }
        )
        let item = items[0]
        if (!item) {
          item = await inventoryModule.createInventoryItems({
            sku: variant.sku || assortmentId,
            title: variant.title,
            metadata: { moysklad_id: assortmentId },
          })
        }
        if (typeof link?.create !== "function") {
          throw new Error(
            "Модуль связей Medusa (LINK) не инициализирован — перезапустите backend"
          )
        }
        await link.create({
          [Modules.PRODUCT]: { variant_id: variant.id },
          [Modules.INVENTORY]: { inventory_item_id: item.id },
          data: { required_quantity: 1 },
        })
        inventoryItemId = item.id
        inventoryByVariant.set(variant.id, item.id)
      }

      const quantity = calculateMedusaStockedQuantity(
        row,
        exportedReservations.get(inventoryItemId) || 0
      )
      const levels = await inventoryModule.listInventoryLevels(
        { inventory_item_id: inventoryItemId, location_id: location.id },
        { take: 1 }
      )
      if (
        levels[0] &&
        Number(levels[0].stocked_quantity) === quantity
      ) {
        stockUnchanged += 1
        continue
      }

      if (levels[0]) {
        await inventoryModule.updateInventoryLevels({
          inventory_item_id: inventoryItemId,
          location_id: location.id,
          stocked_quantity: quantity,
        })
      } else {
        await inventoryModule.createInventoryLevels({
          inventory_item_id: inventoryItemId,
          location_id: location.id,
          stocked_quantity: quantity,
        })
      }
      stockUpdated += 1
    } catch (error) {
      errors.push(`stock: ${(error as Error).message}`)
    }
  }

  return { stockUpdated, stockUnchanged, errors }
}

/** Полный отчёт остатков выбранного склада */
export async function syncAllMoyskladStock(container: MedusaContainer) {
  const moysklad: MoySkladModuleService = container.resolve(MOYSKLAD_MODULE)
  const { storeId } = await moysklad.resolveDefaults()
  const client = moysklad.getClient()
  let rows: MoySkladStockRow[]
  try {
    rows = await client.listStockByStore(storeId)
  } catch {
    rows = await client.listStockAll()
  }
  return applyMoyskladStockRows(container, rows)
}
