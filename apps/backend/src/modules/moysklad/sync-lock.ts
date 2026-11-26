import { randomUUID } from "node:crypto"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import { getSyncState } from "./sync-state"
import { getSearchReindexState } from "../search-reindex/state"

type SqlClient = {
  raw: (
    sql: string,
    bindings?: unknown[]
  ) => Promise<Array<{ id: string }> | { rows?: Array<{ id: string }> }>
}

function rowsOf<T>(result: Array<T> | { rows?: Array<T> }): T[] {
  return Array.isArray(result) ? result : result.rows || []
}

/** Снимает lock без токена (осиротевшая блокировка после рестарта). */
export async function forceReleaseSyncLock(
  container: MedusaContainer,
  key: string
): Promise<void> {
  const sql = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as SqlClient
  await sql.raw(
    `
    UPDATE moysklad_sync_lock
    SET locked_until = NULL,
        lock_token = NULL,
        updated_at = NOW()
    WHERE key = ?
      AND deleted_at IS NULL
    `,
    [key]
  )
}

/**
 * true, если по файлу статуса видно: живого владельца lock уже нет.
 * Иначе после kill/рестарта TTL (до 90 мин) молча блокирует автосинк.
 */
function shouldStealAbandonedLock(key: string): boolean {
  if (key === "catalog") {
    return getSyncState().status !== "running"
  }
  if (key === "search-reindex") {
    return getSearchReindexState().status !== "running"
  }
  return false
}

/**
 * Берёт межпроцессную блокировку через PostgreSQL.
 * TTL защищает от зависшего процесса; осиротевший lock снимаем по статусу.
 */
export async function acquireSyncLock(
  container: MedusaContainer,
  key: string,
  ttlMs = 30 * 60 * 1000
): Promise<string | null> {
  const sql = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as SqlClient
  const token = randomUUID()
  const until = new Date(Date.now() + ttlMs).toISOString()

  // Частичный unique-индекс не поддерживает ON CONFLICT (key) —
  // сначала пытаемся вставить, при гонке просто игнорируем ошибку.
  try {
    await sql.raw(
      `
      INSERT INTO moysklad_sync_lock
        (id, key, locked_until, lock_token, created_at, updated_at)
      VALUES (?, ?, NULL, NULL, NOW(), NOW())
      `,
      [`lock_${key}`, key]
    )
  } catch {
    // запись уже есть
  }

  if (shouldStealAbandonedLock(key)) {
    await forceReleaseSyncLock(container, key)
  }

  const claimed = await sql.raw(
    `
    UPDATE moysklad_sync_lock
    SET locked_until = ?::timestamptz,
        lock_token = ?,
        updated_at = NOW()
    WHERE key = ?
      AND deleted_at IS NULL
      AND (locked_until IS NULL OR locked_until < NOW())
    RETURNING id
    `,
    [until, token, key]
  )

  return rowsOf(claimed).length ? token : null
}

/** Снимает блокировку только своим токеном */
export async function releaseSyncLock(
  container: MedusaContainer,
  key: string,
  token: string
): Promise<void> {
  const sql = container.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as SqlClient
  await sql.raw(
    `
    UPDATE moysklad_sync_lock
    SET locked_until = NULL,
        lock_token = NULL,
        updated_at = NOW()
    WHERE key = ?
      AND lock_token = ?
      AND deleted_at IS NULL
    `,
    [key, token]
  )
}
