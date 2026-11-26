import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

/** Виды запусков в журнале МойСклад */
export type OpsLogKind = "catalog" | "stock" | "force-align" | "search-reindex"

export type OpsLogEntry = {
  id: string
  /** Момент записи (обычно конец запуска) */
  at: string
  kind: OpsLogKind
  status: "ok" | "error"
  trigger?: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  /** Короткая строка для списка */
  summary?: string
  error?: string
  stats?: Record<string, number | undefined>
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ENTRIES = 2000

function resolveLogFile(): string {
  if (process.env.MOYSKLAD_DATA_DIR) {
    return path.join(process.env.MOYSKLAD_DATA_DIR, "moysklad-ops-log.json")
  }
  return path.join(process.cwd(), "..", ".amper-data", "moysklad-ops-log.json")
}

const LOG_FILE = resolveLogFile()

function ensureDir() {
  const dir = path.dirname(LOG_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function prune(entries: OpsLogEntry[], now = Date.now()): OpsLogEntry[] {
  const cut = now - RETENTION_MS
  let next = entries.filter((e) => {
    const t = new Date(e.at || e.finishedAt || 0).getTime()
    return Number.isFinite(t) && t >= cut
  })
  if (next.length > MAX_ENTRIES) {
    next = next.slice(next.length - MAX_ENTRIES)
  }
  return next
}

function readAll(): OpsLogEntry[] {
  try {
    if (!fs.existsSync(LOG_FILE)) return []
    const raw = JSON.parse(fs.readFileSync(LOG_FILE, "utf8")) as unknown
    if (!Array.isArray(raw)) return []
    return prune(raw as OpsLogEntry[])
  } catch {
    return []
  }
}

function writeAll(entries: OpsLogEntry[]) {
  ensureDir()
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2), "utf8")
}

/**
 * Добавляет запись в журнал (месяц / макс. MAX_ENTRIES).
 * Ошибки записи глотаем — журнал не должен ронять синк.
 */
export function appendOpsLog(
  entry: Omit<OpsLogEntry, "id" | "at"> & { at?: string; id?: string }
): void {
  try {
    const at = entry.at || entry.finishedAt || new Date().toISOString()
    const full: OpsLogEntry = {
      ...entry,
      id: entry.id || randomUUID(),
      at,
    }
    const next = prune([...readAll(), full])
    writeAll(next)
  } catch (e) {
    console.error("[ops-log] write failed:", (e as Error).message)
  }
}

/** Новые сверху. limit по умолчанию 100. */
export function listOpsLog(options?: {
  limit?: number
  kind?: OpsLogKind
}): OpsLogEntry[] {
  const limit = Math.min(500, Math.max(1, options?.limit ?? 100))
  let rows = readAll().slice().reverse()
  if (options?.kind) {
    rows = rows.filter((r) => r.kind === options.kind)
  }
  return rows.slice(0, limit)
}

export const OPS_LOG_KIND_LABEL: Record<OpsLogKind, string> = {
  catalog: "Каталог",
  stock: "Остатки",
  "force-align": "Выравнивание",
  "search-reindex": "Поиск",
}
