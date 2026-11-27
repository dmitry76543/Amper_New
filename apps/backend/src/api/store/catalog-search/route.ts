import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  ContainerRegistrationKeys,
  MedusaError,
  ProductStatus,
} from "@medusajs/framework/utils"
import { buildNormTextSql, foldSearchLatin } from "./search-fold"

type Body = {
  q?: string
  category_id?: string
  pagination?: { take?: number; skip?: number }
}

const CATALOG_TABLE = "search_postgres_index"
const MIN_TOKEN = 2
/** Опечатки только для длинных «буквенных» кусков — иначе AND разъезжается */
const TYPO_MIN_TOKEN = 4
/**
 * Fuzzy только если в куске есть удвоение букв (ссверла).
 * На обычном «сверла» word_similarity сильно раздувает выдачу.
 */
const TYPO_THRESHOLD = 0.4

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

/** Цифра «3» или код «А» — осмысленный кусок; короткий мусор отбрасываем */
function isKeepableToken(token: string): boolean {
  if (!token) return false
  if (/^\d+$/.test(token)) return true
  return token.length >= MIN_TOKEN
}

/** Куски запроса: пробелы/запятые; цифры оставляем даже из 1 знака */
function tokenize(q: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of foldSearchLatin(q).split(/[\s,;|/]+/)) {
    const token = part.trim()
    if (!isKeepableToken(token) || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

/** Экранирование спецсимволов для POSIX-regex */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * С начала слова: «топор» и «топорище» — да, «стопор» — нет.
 * После foldSearchLatin в тексте только латиница/цифры.
 */
function wordPrefixPattern(variant: string): string {
  return `(^|[^a-z0-9])${escapeRegex(variant)}`
}

/** ссверла → сверла (убрать удвоенные буквы) */
function collapseRepeats(token: string): string {
  return token.replace(/(.)\1+/gi, "$1")
}

/**
 * Варианты куска: как ввели + без удвоений.
 * Обрезку окончания (сверла→сверл) только для длинных слов —
 * иначе «раств»→«раст» цепляет «растений».
 */
function tokenVariants(token: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: string) => {
    if (!isKeepableToken(value) || seen.has(value)) return
    seen.add(value)
    out.push(value)
  }

  push(token)
  if (/[0-9]/.test(token)) return out

  const collapsed = collapseRepeats(token)
  // Не сжимаем ВВП/ВВГ → vp/vg: иначе «ВП-150», «ВПК» всплывают по «ВВП».
  // ссверла→sverla (длиннее) — ок; порог 4 отсекает двух-трёхбуквенный мусор.
  if (collapsed.length >= 4) push(collapsed)
  // «раств»(5) не режем; «сверла»(6)→«сверл» ещё можно
  if (collapsed.length >= 6) push(collapsed.slice(0, -1))
  if (collapsed.length >= 8) push(collapsed.slice(0, -2))
  return out
}

/** Цифры/артикулы не «угадываем» опечатками — только точная подстрока */
function isStrictToken(token: string): boolean {
  return /[0-9]/.test(token) || token.length < TYPO_MIN_TOKEN
}

/**
 * Soft-fuzzy только при удвоениях в длинных словах: ссверла, аавтомат.
 * Короткие коды вроде ШВВП→shvvp (две «v» из «ВВ») не считаем опечаткой:
 * иначе word_similarity цепляет «швейной» (shveinoi).
 */
function allowFuzzyTypo(token: string): boolean {
  if (isStrictToken(token) || !/^[a-z]+$/i.test(token)) return false
  if (token.length < 6) return false
  return collapseRepeats(token) !== token
}

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
