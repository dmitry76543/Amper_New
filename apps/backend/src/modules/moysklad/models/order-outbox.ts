import { model } from "@medusajs/framework/utils"

/**
 * Постоянная очередь доставки заказов Medusa в МойСклад.
 * Уникальный order_id не позволяет поставить один заказ в очередь дважды.
 */
const MoyskladOrderOutbox = model.define("moysklad_order_outbox", {
  id: model.id().primaryKey(),
  order_id: model.text().unique(),
  status: model
    .enum(["pending", "processing", "retry", "completed", "failed"])
    .default("pending"),
  attempts: model.number().default(0),
  next_attempt_at: model.dateTime().nullable(),
  locked_at: model.dateTime().nullable(),
  last_error: model.text().nullable(),
  moysklad_order_id: model.text().nullable(),
  moysklad_order_name: model.text().nullable(),
})

export default MoyskladOrderOutbox
