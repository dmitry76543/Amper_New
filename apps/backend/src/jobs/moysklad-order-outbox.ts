import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { MOYSKLAD_MODULE } from "../modules/moysklad"
import type MoySkladModuleService from "../modules/moysklad/service"
import {
  enqueueOrderExport,
  processOrderExport,
} from "../modules/moysklad/order-export"

type QueueRow = {
  id: string
  order_id: string
  attempts: number
}

/**
 * Доставляет очередь заказов и подбирает недавние заказы, событие которых
 * могло потеряться до постановки в очередь.
 */
export default async function moyskladOrderOutboxJob(
  container: MedusaContainer
) {
  if (process.env.MOYSKLAD_ALLOW_WRITES !== "true") return

  const sql = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const service: MoySkladModuleService = container.resolve(MOYSKLAD_MODULE)

  const missing = await sql.raw(`
    SELECT o.id
    FROM "order" o
    WHERE o.deleted_at IS NULL
      AND o.canceled_at IS NULL
      AND o.created_at >= NOW() - INTERVAL '48 hours'
      AND COALESCE(o.metadata->>'moysklad_order_id', '') = ''
      AND NOT EXISTS (
        SELECT 1
        FROM moysklad_order_outbox q
        WHERE q.order_id = o.id
          AND q.deleted_at IS NULL
      )
    ORDER BY o.created_at
    LIMIT 100
  `)
  const missingRows = Array.isArray(missing) ? missing : missing.rows || []
  for (const row of missingRows as Array<{ id: string }>) {
    await enqueueOrderExport(container, row.id)
  }

  // Зависший processing после остановки процесса снова становится доступным.
  await sql.raw(`
    UPDATE moysklad_order_outbox
    SET status = 'retry',
        locked_at = NULL,
        next_attempt_at = NOW(),
        updated_at = NOW()
    WHERE status = 'processing'
      AND locked_at < NOW() - INTERVAL '10 minutes'
      AND deleted_at IS NULL
  `)

  const due = await sql.raw(`
    WITH selected AS (
      SELECT id
      FROM moysklad_order_outbox
      WHERE deleted_at IS NULL
        AND status IN ('pending', 'retry')
        AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
      ORDER BY created_at
      LIMIT 20
      FOR UPDATE SKIP LOCKED
    )
    UPDATE moysklad_order_outbox q
    SET status = 'processing',
        locked_at = NOW(),
        updated_at = NOW()
    FROM selected
    WHERE q.id = selected.id
    RETURNING q.id, q.order_id, q.attempts
  `)
  const rows = (Array.isArray(due) ? due : due.rows || []) as QueueRow[]
  for (const entry of rows) {
    try {
      await processOrderExport(container, entry)
    } catch (error) {
      console.error(
        `[moysklad-order-outbox] ${entry.order_id}:`,
        (error as Error).message
      )
    }
  }

  // Обращение к сервису оставляет модуль загруженным и проверяет его регистрацию.
  await service.listMoyskladOrderOutboxes({}, { take: 1 })
}

export const config = {
  name: "moysklad-order-outbox",
  schedule: "* * * * *",
}
