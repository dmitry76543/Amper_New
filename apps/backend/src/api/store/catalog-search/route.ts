import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  MedusaError,
  ProductStatus,
} from "@medusajs/framework/utils"
import { buildNormTextSql } from "./search-fold"
import {
  ensureSearchCache,
  searchInCache,
} from "../../../modules/search-cache"
import {
  allowFuzzyTypo,
  escapeRegex,
  tokenize,
  tokenVariants,
  wordPrefixPattern,
  TYPO_THRESHOLD,
} from "../../../modules/search-cache/matcher"

type Body = {
  q?: string
  category_id?: string
  pagination?: { take?: number; skip?: number }
}

const CATALOG_TABLE = "search_postgres_index"
const MIN_TOKEN = 2

/**
 * Кэш активной таблицы индекса. Раньше на КАЖДЫЙ поиск уходило три JOIN
 * по служебным таблицам, хотя версия меняется раз в сутки (ночная пересборка).
 * Держим имя/таблицу в памяти процесса и перепроверяем раз в минуту.
 */
const ACTIVE_INDEX_TTL_MS = 60_000
let activeIndexCache:
  | { name: string; tableName: string; expiresAt: number }
  | null = null

function normalizeQuery(raw: unknown): string {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
}

/**
 * Текст индекса и запроса в одной латинице:
 * «ВВГ» и handle `vvg` / «VVG» совпадают; «топоры» → topor…
 */
const NORM_TEXT = buildNormTextSql(`"search_text"`)

type SqlResult<T> = { rows?: T[] } | T[]

function rowsOf<T>(result: SqlResult<T>): T[] {
  return Array.isArray(result) ? result : result.rows || []
}

type Knx = {
  raw: (sql: string, params?: unknown[]) => Promise<unknown>
}

/**
 * Активная версия индекса (search_index.active_version), не «последнее имя».
 * Иначе после swap/недособранной product_vN витрина может читать дырявую таблицу.
 */
async function resolveActiveTable(knex: Knx): Promise<string> {
  if (activeIndexCache && activeIndexCache.expiresAt > Date.now()) {
    return activeIndexCache.tableName
  }

  let rows = rowsOf<{ table_name?: string }>(
    (await knex.raw(
      `SELECT spi."name", spi."table_name"
       FROM "search_index" si
       INNER JOIN "search_index_version" siv
         ON siv."search_index_id" = si."id"
        AND siv."version" = si."active_version"
        AND siv."deleted_at" IS NULL
       INNER JOIN "${CATALOG_TABLE}" spi
         ON spi."name" = siv."physical_name"
       WHERE si."name" = 'product'
         AND si."deleted_at" IS NULL
         AND siv."status" = 'ready'
       LIMIT 1`
    )) as SqlResult<{ table_name?: string }>
  )

  if (!rows[0]?.table_name) {
    // Запасной путь для старых схем без search_index
    rows = rowsOf<{ table_name?: string }>(
      (await knex.raw(
        `SELECT "name", "table_name"
         FROM "${CATALOG_TABLE}"
         WHERE "name" LIKE 'product%'
         ORDER BY "name" DESC
         LIMIT 1`
      )) as SqlResult<{ table_name?: string }>
    )
  }

  const tableName = String(rows[0]?.table_name || "").trim()
  if (tableName && /^[a-zA-Z0-9_]+$/.test(tableName)) {
    activeIndexCache = {
      name: tableName,
      tableName,
      expiresAt: Date.now() + ACTIVE_INDEX_TTL_MS,
    }
  }
  return tableName
}

/**
 * Умный поиск витрины: все куски слова должны совпасть (AND),
 * плюс опечатки через pg_trgm word_similarity.
 * POST /store/catalog-search
 */
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = (req.body || {}) as Body
  const q = normalizeQuery(body.q)
  const tokens = tokenize(q)
  if (!tokens.length) {
    res.status(400).json({ message: "Укажите поисковый запрос" })
    return
  }

  const take = Math.min(Math.max(Number(body.pagination?.take) || 48, 1), 100)
  const skip = Math.max(Number(body.pagination?.skip) || 0, 0)
  const categoryId = String(body.category_id || "").trim() || null

  /**
   * Основной путь — in-memory индекс.
   * На 11.6k товарах это единицы миллисекунд против секунд в SQL:
   * свёртка уже посчитана при сборке снимка, а не на каждый запрос.
   */
  const cache = await ensureSearchCache(req.scope)
  const cached = cache
    ? searchInCache(q, { categoryId, take, skip })
    : null
  if (cached) {
    res.json({
      results: [
        {
          hits: cached.hits.map((hit) => ({
            id: hit.id,
            score: hit.score,
            document: { id: hit.id },
          })),
          metadata: {
            count: cached.total,
            skip,
            take,
            query: q,
            tokens,
            source: "memory",
          },
        },
      ],
    })
    return
  }

  // Снимок ещё не готов (старт процесса) — считаем в SQL, чтобы витрина жила
  const knex = req.scope.resolve(
    ContainerRegistrationKeys.PG_CONNECTION
  ) as Knx

  const tableName = await resolveActiveTable(knex)
  if (!tableName) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      "Индекс товаров для поиска ещё не готов"
    )
  }

  const params: Array<string | number> = []
  const tokenClauses: string[] = []

  for (const token of tokens) {
    const variants = tokenVariants(token)
    const matchParts: string[] = []
    for (const variant of variants) {
      params.push(wordPrefixPattern(variant))
      matchParts.push(`n.search_norm ~ ?`)
      // Буквенный код ≥3: ещё и подстрока — «ВВП» находит «ШВВП», «ВВГ» → «ВВГнг».
      // Не путать со сжатием vv→vp (его выше отключили): ищем сам введённый кусок.
      if (/^[a-z]+$/i.test(variant) && variant.length >= 3) {
        params.push(escapeRegex(variant))
        matchParts.push(`n.search_norm ~ ?`)
      }
    }

    if (allowFuzzyTypo(token)) {
      params.push(token)
      tokenClauses.push(
        `((${matchParts.join(" OR ")}) OR word_similarity(?, n.search_norm) > ${TYPO_THRESHOLD})`
      )
    } else {
      tokenClauses.push(`((${matchParts.join(" OR ")}))`)
    }
  }

  const whereSql = tokenClauses.join(" AND ")

  // Ранг: с начала слова выше, чем просто подстрока (ВВП внутри ШВВП)
  const rankParams: Array<string | number> = []
  const rankBits: string[] = []
  for (const token of tokens) {
    rankParams.push(wordPrefixPattern(token))
    if (/^[a-z]+$/i.test(token) && token.length >= 3) {
      rankParams.push(escapeRegex(token))
      rankBits.push(
        `(CASE WHEN n.search_norm ~ ? THEN 1.0 WHEN n.search_norm ~ ? THEN 0.7 ELSE 0.2 END)`
      )
    } else {
      rankBits.push(`(CASE WHEN n.search_norm ~ ? THEN 1.0 ELSE 0.2 END)`)
    }
  }
  const rankSql = `(${rankBits.join(" + ")})`

  /**
   * Параметры в порядке появления в тексте SQL:
   * CTE (статус, категория) → ранжирование → условия WHERE → LIMIT/OFFSET.
   */
  const cteParams: Array<string | number> = [
    JSON.stringify({ status: ProductStatus.PUBLISHED }),
  ]
  let cteFilter = `"indexed" @> ?::jsonb`
  if (categoryId) {
    // category_ids — массив в indexed; @> ищет вхождение id
    cteParams.push(JSON.stringify({ category_ids: [categoryId] }))
    cteFilter += ` AND "indexed" @> ?::jsonb`
  }

  const listParams = [
    ...cteParams,
    ...rankParams,
    ...params,
    take,
    skip,
  ]

  /**
   * MATERIALIZED — принципиально: свёртка считается ОДИН раз на строку.
   * Без него Postgres «разворачивает» подзапрос и повторяет translate/replace
   * в каждом условии и в ранжировании (до 6 копий на токен).
   * Фильтр статуса остаётся внутри CTE в форме `@>`, чтобы сработал GIN
   * "…_indexed_idx" (jsonb_path_ops) и до свёртки дошло меньше строк.
   *
   * COUNT(*) OVER () даёт полное число совпадений в том же проходе —
   * раньше рядом выполнялся отдельный SELECT COUNT(*) с тем же тяжёлым WHERE.
   */
  const listRows = rowsOf<{
    id?: string
    document?: { id?: string } | string
    score?: number
    total?: number
  }>(
    (await knex.raw(
      `WITH n AS MATERIALIZED (
         SELECT "id", "document", ${NORM_TEXT} AS search_norm
         FROM "${tableName}"
         WHERE ${cteFilter}
       )
       SELECT "id", "document", ${rankSql} AS score, COUNT(*) OVER () AS total
       FROM n
       WHERE ${whereSql}
       ORDER BY score DESC, "id" ASC
       LIMIT ? OFFSET ?`,
      listParams
    )) as SqlResult<{
      id?: string
      document?: { id?: string } | string
      score?: number
      total?: number
    }>
  )

  const hits = listRows.map((row) => {
    const document =
      typeof row.document === "string"
        ? (JSON.parse(row.document) as { id?: string })
        : row.document
    const id = String(document?.id || row.id || "")
    return {
      id,
      score: Number(row.score) || 0,
      document: { id },
    }
  })

  // При пустой выдаче строк нет — значит и совпадений нет.
  const count = listRows.length ? Number(listRows[0]?.total || 0) : 0

  res.json({
    results: [
      {
        hits,
        metadata: {
          count,
          skip,
          take,
          query: q,
          tokens,
        },
      },
    ],
  })
}
