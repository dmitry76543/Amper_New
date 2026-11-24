import type { MoySkladStockRow } from "./types"

type SqlClient = {
  raw: (
    sql: string
  ) => Promise<
    | Array<{ inventory_item_id: string; quantity: string | number }>
    | {
        rows?: Array<{ inventory_item_id: string; quantity: string | number }>
      }
  >
}

/**
 * Локальные резервы уже вычитаются Medusa из stocked_quantity.
 * Возвращаем только ту их часть, которая подтверждённо попала в МойСклад,
 * чтобы один и тот же резерв не вычитался второй раз.
 */
export async function loadExportedLocalReservations(
  sql: SqlClient
): Promise<Map<string, number>> {
  const result = await sql.raw(`
    SELECT
      ri.inventory_item_id,
      COALESCE(SUM(ri.quantity), 0) AS quantity
    FROM reservation_item ri
    WHERE ri.deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM order_item oi
        JOIN "order" o ON o.id = oi.order_id
        WHERE oi.item_id = ri.line_item_id
          AND oi.deleted_at IS NULL
          AND o.deleted_at IS NULL
          AND COALESCE(o.metadata->>'moysklad_order_id', '') <> ''
      )
    GROUP BY ri.inventory_item_id
  `)
  const rows = Array.isArray(result) ? result : result.rows || []
  return new Map(
    rows.map((row) => [
      row.inventory_item_id,
      Math.max(0, Number(row.quantity) || 0),
    ])
  )
}

/**
 * Количество, которое записываем в stocked_quantity Medusa.
 *
 * МойСклад: физический остаток минус все резервы.
 * Medusa затем сама вычитает свои локальные резервы. Подтверждённые резервы
 * заказов сайта добавляем обратно, чтобы избежать двойного вычитания.
 * Ожидаемые поступления намеренно не учитываем — предзаказы пока выключены.
 */
export function calculateMedusaStockedQuantity(
  row: MoySkladStockRow,
  exportedLocalReserve = 0
): number {
  const physicalStock = Number(row.stock ?? 0) || 0
  const moyskladReserve = Number(row.reserve ?? 0) || 0
  const availableInMoysklad = Number.isFinite(Number(row.freeStock))
    ? Number(row.freeStock)
    : physicalStock - moyskladReserve
  return Math.max(
    0,
    Math.floor(availableInMoysklad + exportedLocalReserve)
  )
}
