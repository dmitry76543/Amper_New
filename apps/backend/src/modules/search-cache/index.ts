import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, ProductStatus } from "@medusajs/framework/utils"
import { foldSearchLatin } from "../../api/store/catalog-search/search-fold"
import {
  buildMatchers,
  buildTokenTrigrams,
  rankFor,
  tokenize,
  trigramSimilarity,
  TYPO_THRESHOLD,
  variantMatches,
} from "./matcher"

/**
 * In-memory индекс поиска витрины.
 *
 * Зачем: полный каталог — это ~1.2 МБ свёрнутого текста на 11.6k товаров.
 * Пересчитывать свёртку в SQL на каждый символ стоило 4–9 секунд даже
 * после подъёма тарифа БД (замер: 4990 мс медиана). Поиск по тому же
 * массиву в памяти — единицы миллисекунд.
 *
 * Источник истины остаётся в таблице поиска Medusa: кэш только читает её
 * и обновляется по событиям. Если кэш не готов — маршрут падает обратно на SQL.
 */

export type CachedDoc = {
  id: string
  /** Свёрнутый поисковый текст (та же свёртка, что и в SQL) */
  norm: string
  /** Слова свёрнутого текста — для fuzzy-ветки */
  words: string[]
  /** Фильтры из indexed: нужны для категории и статуса */
  status: string
  categoryIds: string[]
}

type Snapshot = {
  docs: CachedDoc[]
  /** Версия физической таблицы, из которой собрано */
  source: string
  builtAt: number
  buildMs: number
  /**
   * Триграммы уникальных слов: считаются при сборке снимка, не на запрос.
   * Нужны для fuzzy-ветки — перебор всех слов на каждый запрос стоил 30 мс.
   */
  gramsByWord: Map<string, Map<string, number>>
  /** Обратный индекс «триграмма → слова». Сужает кандидатов в 18 раз. */
  wordsByGram: Map<string, string[]>
}

/** Полная перезагрузка не чаще, чем раз в N мс (защита от шторма событий) */
const MIN_REBUILD_GAP_MS = 15_000
/** Пересборка, если снимок старше: страховка от потерянных событий */
const MAX_STALE_MS = 30 * 60 * 1000

let snapshot: Snapshot | null = null
let inFlight: Promise<Snapshot | null> | null = null
let lastBuildStart = 0
let pendingRebuild = false

type Knx = { raw: (sql: string, params?: unknown[]) => Promise<unknown> }

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : ((result as { rows?: T[] }).rows || [])
}

/** Активная физическая таблица поиска (как в маршруте, но свой кэш) */
async function resolveActiveTable(knex: Knx): Promise<string> {
  let rows = rowsOf<{ table_name?: string }>(
    await knex.raw(
      `SELECT spi."table_name"
       FROM "search_index" si
       INNER JOIN "search_index_version" siv
         ON siv."search_index_id" = si."id"
        AND siv."version" = si."active_version"
        AND siv."deleted_at" IS NULL
       INNER JOIN "search_postgres_index" spi
         ON spi."name" = siv."physical_name"
       WHERE si."name" = 'product'
         AND si."deleted_at" IS NULL
         AND siv."status" = 'ready'
       LIMIT 1`
    )
  )
  if (!rows[0]?.table_name) {
    rows = rowsOf<{ table_name?: string }>(
      await knex.raw(
        `SELECT "table_name"
         FROM "search_postgres_index"
         WHERE "name" LIKE 'product%'
         ORDER BY "name" DESC
         LIMIT 1`
      )
    )
  }
  const tableName = String(rows[0]?.table_name || "").trim()
  return /^[a-zA-Z0-9_]+$/.test(tableName) ? tableName : ""
}

function toDoc(row: {
  id?: string
  search_text?: string
  indexed?: { status?: string; category_ids?: string[] } | string
}): CachedDoc | null {
  const id = String(row.id || "")
  if (!id) return null
  let indexed: { status?: string; category_ids?: string[] } = {}
  const rawIndexed = row.indexed
  if (typeof rawIndexed === "string") {
    try {
      indexed = JSON.parse(rawIndexed) as typeof indexed
    } catch {
      indexed = {}
    }
  } else if (rawIndexed && typeof rawIndexed === "object") {
    indexed = rawIndexed
  }
  const norm = foldSearchLatin(row.search_text || "")
  return {
    id,
    norm,
    words: norm.split(/\s+/).filter(Boolean),
    status: String(indexed.status || ""),
    categoryIds: Array.isArray(indexed.category_ids) ? indexed.category_ids : [],
  }
}

/** Собирает снимок из таблицы поиска */
async function buildSnapshot(container: MedusaContainer): Promise<Snapshot | null> {
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as Knx
  const table = await resolveActiveTable(knex)
  if (!table) return null

  const started = Date.now()
  // Статус лежит в indexed (jsonb), а не отдельной колонкой, поэтому
  // фильтруем в JS: тащить sql-условие по jsonb ради 11.6k строк невыгодно.
  const raw = await knex.raw(
    `SELECT "id", "search_text", "indexed" FROM "${table}"`
  )
  const rows = rowsOf<{
    id?: string
    search_text?: string
    indexed?: { status?: string; category_ids?: string[] } | string
  }>(raw)

  const docs: CachedDoc[] = []
  for (const row of rows) {
    const doc = toDoc(row)
    if (!doc) continue
    if (doc.status !== ProductStatus.PUBLISHED) continue
    docs.push(doc)
  }

  // Триграммы уникальных слов — один раз при сборке, а не на каждый поиск
  const uniqueWords = new Set<string>()
  for (const doc of docs) {
    for (const word of doc.words) uniqueWords.add(word)
  }
  const gramsByWord = new Map<string, Map<string, number>>()
  const wordsByGram = new Map<string, string[]>()
  for (const word of uniqueWords) {
    const grams = buildTokenTrigrams(word)
    gramsByWord.set(word, grams)
    for (const gram of grams.keys()) {
      let list = wordsByGram.get(gram)
      if (!list) {
        list = []
        wordsByGram.set(gram, list)
      }
      list.push(word)
    }
  }

  return {
    docs,
    source: table,
    builtAt: Date.now(),
    buildMs: Date.now() - started,
    gramsByWord,
    wordsByGram,
  }
}

/**
 * Пересобрать снимок. Параллельные вызовы склеиваются в один:
 * при шторме событий нет смысла строить индекс десять раз.
 */
export async function refreshSearchCache(
  container: MedusaContainer,
  { force = false }: { force?: boolean } = {}
): Promise<Snapshot | null> {
  if (inFlight) return inFlight
  const sinceLast = Date.now() - lastBuildStart
  if (!force && sinceLast < MIN_REBUILD_GAP_MS) {
    // Слишком часто — отметим, что нужна пересборка, и отдадим текущий снимок
    pendingRebuild = true
    return snapshot
  }
  lastBuildStart = Date.now()
  inFlight = (async () => {
    try {
      const built = await buildSnapshot(container)
      if (built) {
        pendingRebuild = false
        const prev = snapshot
        snapshot = built
        console.log("[search-cache] rebuilt:", {
          docs: built.docs.length,
          source: built.source,
          buildMs: built.buildMs,
          changed: !prev || prev.source !== built.source || prev.docs.length !== built.docs.length,
        })
      }
      return built
    } catch (error) {
      console.error("[search-cache] rebuild failed:", (error as Error).message)
      return snapshot
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/**
 * Убедиться, что снимок есть и не устарел.
 * Вызывается и на старте (прогрев), и лениво из маршрута.
 */
export async function ensureSearchCache(
  container: MedusaContainer
): Promise<Snapshot | null> {
  if (!snapshot) return refreshSearchCache(container, { force: true })
  if (Date.now() - snapshot.builtAt > MAX_STALE_MS) {
    return refreshSearchCache(container, { force: true })
  }
  // Если во время «окна тишины» пришли события — дочешем отложенное
  if (pendingRebuild) {
    void refreshSearchCache(container, { force: false })
  }
  return snapshot
}

export function getSearchCacheStats() {
  return {
    ready: Boolean(snapshot),
    docs: snapshot?.docs.length ?? 0,
    source: snapshot?.source ?? null,
    builtAt: snapshot?.builtAt ? new Date(snapshot.builtAt).toISOString() : null,
    ageMs: snapshot ? Date.now() - snapshot.builtAt : null,
    buildMs: snapshot?.buildMs ?? null,
    pendingRebuild,
  }
}

/** Принудительный сброс (после ночного синка или смены версии индекса) */
export async function invalidateSearchCache(
  container: MedusaContainer
): Promise<Snapshot | null> {
  return refreshSearchCache(container, { force: true })
}

export type SearchHit = { id: string; score: number }

export type SearchCacheResult = {
  hits: SearchHit[]
  total: number
}

/**
 * Поиск по снимку. Правила совпадения — из ./matcher, те же, что в SQL-пути.
 *
 * Сложность линейная по числу товаров (11.6k) — это ~2 мс, поэтому
 * никаких индексов внутри кэша не нужно.
 */
export function searchInCache(
  q: string,
  options: { categoryId?: string | null; take?: number; skip?: number } = {}
): SearchCacheResult | null {
  if (!snapshot) return null

  const tokens = tokenize(q)
  if (!tokens.length) return { hits: [], total: 0 }

  const matchers = buildMatchers(tokens)
  const fuzzyTrigrams = matchers.map((m) =>
    m.fuzzy ? buildTokenTrigrams(m.token) : null
  )

  const categoryId = options.categoryId ? String(options.categoryId) : null
  const take = Math.min(Math.max(Number(options.take) || 48, 1), 100)
  const skip = Math.max(Number(options.skip) || 0, 0)

  /**
   * Fuzzy только когда кусок похож на опечатку (удвоение букв), поэтому
   * дорогая ветка включается у меньшинства запросов.
   *
   * Кандидатов берём из обратного индекса триграмм: перебор всех 44k слов
   * стоил 30 мс, через индекс — 1.7 мс при том же результате
   * (замер: 2401 кандидат вместо 44127, те же 15 совпадений).
   */
  const fuzzyWordsByToken = new Map<number, Set<string>>()
  for (let i = 0; i < matchers.length; i++) {
    const grams = fuzzyTrigrams[i]
    if (!grams) continue
    // Верхняя граница: sim ≤ 2*totalA/(totalA+totalB), значит для sim > 0.4
    // нужно totalB < 4*totalA → длина слова не больше 4x длины токена.
    const maxLen = 4 * (matchers[i].token.length + 2) - 2

    const candidates = new Set<string>()
    for (const gram of grams.keys()) {
      for (const word of snapshot.wordsByGram.get(gram) || []) candidates.add(word)
    }

    const similar = new Set<string>()
    for (const word of candidates) {
      if (word.length > maxLen) continue
      const wordGrams = snapshot.gramsByWord.get(word)
      if (wordGrams && trigramSimilarity(grams, wordGrams) > TYPO_THRESHOLD) {
        similar.add(word)
      }
    }
    fuzzyWordsByToken.set(i, similar)
  }

  const matched: SearchHit[] = []

  for (const doc of snapshot.docs) {
    if (categoryId && !doc.categoryIds.includes(categoryId)) continue

    let ok = true
    let score = 0
    for (let i = 0; i < matchers.length; i++) {
      const matcher = matchers[i]
      let hit = matcher.variants.some((variant) => variantMatches(doc.norm, variant))

      // fuzzy-ветка: как `word_similarity(?, search_norm) > 0.4`
      if (!hit) {
        const similar = fuzzyWordsByToken.get(i)
        if (similar) {
          for (const word of doc.words) {
            if (similar.has(word)) {
              hit = true
              break
            }
          }
        }
      }

      if (!hit) {
        ok = false
        break
      }
      score += rankFor(doc.norm, matcher)
    }

    if (ok) matched.push({ id: doc.id, score })
  }

  matched.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))

  return {
    hits: matched.slice(skip, skip + take),
    total: matched.length,
  }
}
