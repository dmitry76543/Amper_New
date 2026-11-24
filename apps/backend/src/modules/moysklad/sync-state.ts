import fs from "node:fs"
import path from "node:path"

export type SyncTrigger = "manual" | "schedule" | "cli" | "webhook"

export type SyncRunResult = {
  created?: number
  updated?: number
  unchanged?: number
  skipped?: number
  imagesSynced?: number
  stockUpdated?: number
  stockUnchanged?: number
  hidden?: number
  errors?: string[]
}

export type MoySkladSyncState = {
  /** Интервал автосинка каталога в минутах (1–1440) */
  intervalMinutes: number
  /** Страхующий интервал остатков в минутах (1–60) */
  stockIntervalMinutes: number
  status: "idle" | "running" | "ok" | "error"
  trigger?: SyncTrigger
  startedAt?: string
  finishedAt?: string
  nextDueAt?: string
  result?: SyncRunResult
  error?: string
  lastStockSyncAt?: string
  /** Сколько длилась последняя страховка остатков, мс */
  lastStockDurationMs?: number
  stockRequestedAt?: string
  stockError?: string
  /** YYYY-MM-DD последнего ночного полного прогона */
  nightlyDoneDate?: string
}

const DEFAULT_INTERVAL = 15
const DEFAULT_STOCK_INTERVAL = 2

/**
 * Файл статуса нельзя держать в apps/backend/data:
 * medusa develop следит за этой папкой и при каждой записи перезапускает
 * сервер — синк сам себя убивает.
 */
function resolveStateFile(): string {
  if (process.env.MOYSKLAD_DATA_DIR) {
    return path.join(process.env.MOYSKLAD_DATA_DIR, "moysklad-sync-state.json")
  }
  return path.join(process.cwd(), "..", ".amper-data", "moysklad-sync-state.json")
}

const STATE_FILE = resolveStateFile()
const LEGACY_STATE_FILE = path.join(process.cwd(), "data", "moysklad-sync-state.json")

let memory: MoySkladSyncState | null = null

function clampInterval(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL
  return Math.min(1440, Math.max(1, Math.round(n)))
}

function clampStockInterval(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_STOCK_INTERVAL
  return Math.min(60, Math.max(1, Math.round(n)))
}

function ensureDir() {
  const dir = path.dirname(STATE_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/** Перенос старого файла из apps/backend/data, если новый ещё пуст */
function migrateLegacyStateIfNeeded() {
  try {
    if (fs.existsSync(STATE_FILE) || !fs.existsSync(LEGACY_STATE_FILE)) return
    ensureDir()
    fs.copyFileSync(LEGACY_STATE_FILE, STATE_FILE)
  } catch {
    // перенос не критичен — дальше читаем как обычно
  }
}

function readDisk(): MoySkladSyncState {
  migrateLegacyStateIfNeeded()
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(
        fs.readFileSync(STATE_FILE, "utf8")
      ) as Partial<MoySkladSyncState>
      const intervalMinutes = clampInterval(
        Number(raw.intervalMinutes ?? DEFAULT_INTERVAL)
      )
      const stockIntervalMinutes = clampStockInterval(
        Number(raw.stockIntervalMinutes ?? DEFAULT_STOCK_INTERVAL)
      )
      // Если backend перезапустился при running, прежний процесс уже точно
      // не работает. Не маскируем обрыв словом «ожидание».
      if (raw.status === "running") {
        const finishedAt = new Date().toISOString()
        const interrupted: MoySkladSyncState = {
          intervalMinutes,
          stockIntervalMinutes,
          status: "error",
          trigger: raw.trigger,
          startedAt: raw.startedAt,
          finishedAt,
          nextDueAt: computeNextDueAt(finishedAt, intervalMinutes),
          result: raw.result,
          lastStockSyncAt: raw.lastStockSyncAt,
          lastStockDurationMs: raw.lastStockDurationMs,
          stockRequestedAt: raw.stockRequestedAt,
          stockError: raw.stockError,
          nightlyDoneDate: raw.nightlyDoneDate,
          error:
            "Предыдущая синхронизация оборвалась при перезапуске backend. Запустите её снова.",
        }
        writeDisk(interrupted)
        return interrupted
      }
      return {
        intervalMinutes,
        stockIntervalMinutes,
        status: raw.status || "idle",
        trigger: raw.trigger,
        startedAt: raw.startedAt,
        finishedAt: raw.finishedAt,
        nextDueAt: raw.nextDueAt,
        result: raw.result,
        error: raw.error,
        lastStockSyncAt: raw.lastStockSyncAt,
        lastStockDurationMs: raw.lastStockDurationMs,
        stockRequestedAt: raw.stockRequestedAt,
        stockError: raw.stockError,
        nightlyDoneDate: raw.nightlyDoneDate,
      }
    }
  } catch {
    // битый файл — начнём с дефолта
  }
  return {
    intervalMinutes: DEFAULT_INTERVAL,
    stockIntervalMinutes: DEFAULT_STOCK_INTERVAL,
    status: "idle",
  }
}

function writeDisk(state: MoySkladSyncState) {
  ensureDir()
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")
}

/** Текущее состояние синка (файл + память процесса) */
export function getSyncState(): MoySkladSyncState {
  if (!memory) memory = readDisk()
  return { ...memory }
}

export function saveSyncState(
  patch: Partial<MoySkladSyncState>
): MoySkladSyncState {
  const prev = getSyncState()
  memory = {
    ...prev,
    ...patch,
    intervalMinutes: clampInterval(
      Number(patch.intervalMinutes ?? prev.intervalMinutes ?? DEFAULT_INTERVAL)
    ),
    stockIntervalMinutes: clampStockInterval(
      Number(
        patch.stockIntervalMinutes ??
          prev.stockIntervalMinutes ??
          DEFAULT_STOCK_INTERVAL
      )
    ),
  }
  writeDisk(memory)
  return { ...memory }
}

/** Нужно ли выполнить страхующую сверку остатков */
export function shouldRunStockSync(now = Date.now()): boolean {
  const state = getSyncState()
  if (state.status === "running") return false
  if (state.stockRequestedAt) return true
  if (!state.lastStockSyncAt) return true
  const last = new Date(state.lastStockSyncAt).getTime()
  if (!Number.isFinite(last)) return true
  return now - last >= state.stockIntervalMinutes * 60_000
}

/** Webhook помечает остатки как требующие ближайшего обновления */
export function requestStockSync(): MoySkladSyncState {
  return saveSyncState({
    stockRequestedAt: new Date().toISOString(),
  })
}

export function markStockSyncOk(options?: {
  finishedAt?: string
  durationMs?: number
}) {
  const finishedAt = options?.finishedAt || new Date().toISOString()
  const next = saveSyncState({
    lastStockSyncAt: finishedAt,
    lastStockDurationMs:
      typeof options?.durationMs === "number"
        ? Math.max(0, Math.round(options.durationMs))
        : undefined,
    stockError: undefined,
  })
  // Явно очищаем флаг webhook — иначе запрос будет крутиться вечно
  if (memory) {
    delete memory.stockRequestedAt
    writeDisk(memory)
  }
  return { ...next, stockRequestedAt: undefined }
}

export function markStockSyncError(error: string) {
  return saveSyncState({ stockError: error })
}

export function computeNextDueAt(
  fromIso: string | undefined,
  intervalMinutes: number
): string {
  const base = fromIso ? new Date(fromIso).getTime() : Date.now()
  const t =
    (Number.isFinite(base) ? base : Date.now()) + intervalMinutes * 60_000
  return new Date(t).toISOString()
}

/** Можно ли стартовать новый прогон (не занят) */
export function canStartSync(): boolean {
  return getSyncState().status !== "running"
}

/**
 * Нужен ли автопрогон по интервалу.
 * Job дергается каждую минуту и сам решает.
 */
export function shouldRunScheduledSync(now = Date.now()): boolean {
  const s = getSyncState()
  if (s.status === "running") return false
  if (!s.finishedAt && !s.startedAt) return true
  const last = new Date(s.finishedAt || s.startedAt || 0).getTime()
  if (!Number.isFinite(last)) return true
  return now - last >= s.intervalMinutes * 60_000
}

export function markSyncRunning(trigger: SyncTrigger): MoySkladSyncState {
  const startedAt = new Date().toISOString()
  return saveSyncState({
    status: "running",
    trigger,
    startedAt,
    finishedAt: undefined,
    error: undefined,
    nextDueAt: undefined,
  })
}

export function markSyncOk(
  trigger: SyncTrigger,
  startedAt: string | undefined,
  result: SyncRunResult
): MoySkladSyncState {
  const finishedAt = new Date().toISOString()
  const intervalMinutes = getSyncState().intervalMinutes
  return saveSyncState({
    status: "ok",
    trigger,
    startedAt,
    finishedAt,
    result,
    error: undefined,
    nextDueAt: computeNextDueAt(finishedAt, intervalMinutes),
    lastStockSyncAt: finishedAt,
  })
}

export function markSyncError(
  trigger: SyncTrigger,
  startedAt: string | undefined,
  error: string
): MoySkladSyncState {
  const finishedAt = new Date().toISOString()
  const intervalMinutes = getSyncState().intervalMinutes
  return saveSyncState({
    status: "error",
    trigger,
    startedAt,
    finishedAt,
    error,
    nextDueAt: computeNextDueAt(finishedAt, intervalMinutes),
  })
}
