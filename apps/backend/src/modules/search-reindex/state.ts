import fs from "node:fs"
import path from "node:path"
import { appendOpsLog } from "../moysklad/ops-log"

export type SearchReindexTrigger = "manual" | "schedule" | "cli"

export type SearchReindexState = {
  status: "idle" | "running" | "ok" | "error"
  trigger?: SearchReindexTrigger
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  /** Имена индексов, которые пересобрали */
  indexes?: string[]
  jobId?: string
  error?: string
  /** YYYY-MM-DD последнего ночного прогона */
  nightlyDoneDate?: string
  /** Час ночного запуска (0–23), серверное локальное время */
  nightlyHour: number
}

const DEFAULT_HOUR = 5

function resolveStateFile(): string {
  if (process.env.MOYSKLAD_DATA_DIR) {
    return path.join(process.env.MOYSKLAD_DATA_DIR, "search-reindex-state.json")
  }
  return path.join(process.cwd(), "..", ".amper-data", "search-reindex-state.json")
}

const STATE_FILE = resolveStateFile()
let memory: SearchReindexState | null = null

function clampHour(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HOUR
  return Math.min(23, Math.max(0, Math.round(n)))
}

function ensureDir() {
  const dir = path.dirname(STATE_FILE)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function defaults(): SearchReindexState {
  return {
    status: "idle",
    nightlyHour: clampHour(
      Number(process.env.MOYSKLAD_SEARCH_REINDEX_HOUR ?? DEFAULT_HOUR)
    ),
  }
}

function readDisk(): SearchReindexState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(
        fs.readFileSync(STATE_FILE, "utf8")
      ) as Partial<SearchReindexState>
      const base = { ...defaults(), ...raw }
      base.nightlyHour = clampHour(
        Number(raw.nightlyHour ?? process.env.MOYSKLAD_SEARCH_REINDEX_HOUR ?? DEFAULT_HOUR)
      )
      // После рестарта «running» — обрыв
      if (raw.status === "running") {
        return {
          ...base,
          status: "error",
          error:
            raw.error ||
            "Переиндексация прервана перезапуском сервера. Запустите снова.",
          finishedAt: raw.finishedAt || new Date().toISOString(),
        }
      }
      return base
    }
  } catch {
    // ниже — defaults
  }
  return defaults()
}

function writeDisk(state: SearchReindexState) {
  ensureDir()
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8")
  memory = state
}

export function getSearchReindexState(): SearchReindexState {
  if (!memory) memory = readDisk()
  return { ...memory }
}

export function saveSearchReindexState(
  patch: Partial<SearchReindexState>
): SearchReindexState {
  const next = { ...getSearchReindexState(), ...patch }
  next.nightlyHour = clampHour(Number(next.nightlyHour))
  writeDisk(next)
  return getSearchReindexState()
}

export function markSearchReindexRunning(
  trigger: SearchReindexTrigger
): SearchReindexState {
  return saveSearchReindexState({
    status: "running",
    trigger,
    startedAt: new Date().toISOString(),
    finishedAt: undefined,
    durationMs: undefined,
    indexes: undefined,
    jobId: undefined,
    error: undefined,
  })
}

export function markSearchReindexOk(input: {
  startedAt: string
  indexes?: string[]
  jobId?: string
}): SearchReindexState {
  const finishedAt = new Date().toISOString()
  const durationMs = Math.max(
    0,
    new Date(finishedAt).getTime() - new Date(input.startedAt).getTime()
  )
  const trigger = getSearchReindexState().trigger
  const saved = saveSearchReindexState({
    status: "ok",
    finishedAt,
    durationMs,
    indexes: input.indexes,
    jobId: input.jobId,
    error: undefined,
  })
  appendOpsLog({
    kind: "search-reindex",
    status: "ok",
    trigger,
    startedAt: input.startedAt,
    finishedAt,
    durationMs,
    summary: `Поиск: ${(input.indexes || ["product"]).join(", ")}`,
  })
  return saved
}

export function markSearchReindexError(
  startedAt: string,
  error: string
): SearchReindexState {
  const finishedAt = new Date().toISOString()
  const durationMs = Math.max(
    0,
    new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  )
  const trigger = getSearchReindexState().trigger
  const saved = saveSearchReindexState({
    status: "error",
    finishedAt,
    durationMs,
    error,
  })
  appendOpsLog({
    kind: "search-reindex",
    status: "error",
    trigger,
    startedAt,
    finishedAt,
    durationMs,
    summary: "Пересборка поиска",
    error,
  })
  return saved
}

export function canStartSearchReindex(): boolean {
  return getSearchReindexState().status !== "running"
}
