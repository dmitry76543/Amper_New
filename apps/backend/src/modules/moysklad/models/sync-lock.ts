import { model } from "@medusajs/framework/utils"

/** Межпроцессная блокировка синхронизаций каталога и остатков */
const MoyskladSyncLock = model.define("moysklad_sync_lock", {
  id: model.id().primaryKey(),
  key: model.text().unique(),
  locked_until: model.dateTime().nullable(),
  lock_token: model.text().nullable(),
})

export default MoyskladSyncLock
