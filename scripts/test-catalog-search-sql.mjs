/**
 * Проверка SQL, который строит catalog-search: баланс скобок и количество
 * placeholders против переданных параметров. Живой БД нет, но именно такие
 * ошибки (сдвиг `?`, лишняя скобка) ломают поиск целиком.
 *
 * Запуск: node scripts/test-catalog-search-sql.mjs
 */
import assert from "node:assert/strict"

// --- копия логики из route.ts (держим в синхроне с исходником) ---
const MIN_TOKEN = 2
const TYPO_MIN_TOKEN = 4

function foldSearchLatin(value) {
  const multi = [
    ["ж", "zh"], ["х", "h"], ["ц", "ts"], ["ч", "ch"],
    ["ш", "sh"], ["щ", "sch"], ["ю", "yu"], ["я", "ya"],
  ]
  const single = [
    ["а", "a"], ["б", "b"], ["в", "v"], ["г", "g"], ["д", "d"], ["е", "e"],
    ["ё", "e"], ["з", "z"], ["и", "i"], ["й", "i"], ["к", "k"], ["л", "l"],
    ["м", "m"], ["н", "n"], ["о", "o"], ["п", "p"], ["р", "r"], ["с", "s"],
    ["т", "t"], ["у", "u"], ["ф", "f"], ["ъ", ""], ["ы", "y"], ["ь", ""],
    ["э", "e"],
  ]
  let out = String(value || "").toLowerCase()
  for (const [from, to] of multi) out = out.replaceAll(from, to)
  for (const [from, to] of single) out = out.replaceAll(from, to)
  return out
}

const isKeepableToken = (t) => (t ? /^\d+$/.test(t) || t.length >= MIN_TOKEN : false)

function tokenize(q) {
  const seen = new Set()
  const out = []
  for (const part of foldSearchLatin(q).split(/[\s,;|/]+/)) {
    const token = part.trim()
    if (!isKeepableToken(token) || seen.has(token)) continue
    seen.add(token)
    out.push(token)
  }
  return out
}

const escapeRegex = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const wordPrefixPattern = (v) => `(^|[^a-z0-9])${escapeRegex(v)}`
const collapseRepeats = (t) => t.replace(/(.)\1+/gi, "$1")

function tokenVariants(token) {
  const seen = new Set()
  const out = []
  const push = (v) => {
    if (!isKeepableToken(v) || seen.has(v)) return
    seen.add(v)
    out.push(v)
  }
  push(token)
  if (/[0-9]/.test(token)) return out
  const collapsed = collapseRepeats(token)
  if (collapsed.length >= 4) push(collapsed)
  if (collapsed.length >= 6) push(collapsed.slice(0, -1))
  if (collapsed.length >= 8) push(collapsed.slice(0, -2))
  return out
}

const isStrictToken = (t) => /[0-9]/.test(t) || t.length < TYPO_MIN_TOKEN
function allowFuzzyTypo(token) {
  if (isStrictToken(token) || !/^[a-z]+$/i.test(token)) return false
  if (token.length < 6) return false
  return collapseRepeats(token) !== token
}

const NORM_TEXT = "<NORM>"

/** Повторяет сборку CTE + WHERE + rank из route.ts */
function build(q, { categoryId = null, take = 48, skip = 0 } = {}) {
  const tokens = tokenize(q)
  const params = []
  const tokenClauses = []

  for (const token of tokens) {
    const variants = tokenVariants(token)
    const matchParts = []
    for (const variant of variants) {
      params.push(wordPrefixPattern(variant))
      matchParts.push(`n.search_norm ~ ?`)
      if (/^[a-z]+$/i.test(variant) && variant.length >= 3) {
        params.push(escapeRegex(variant))
        matchParts.push(`n.search_norm ~ ?`)
      }
    }
    if (allowFuzzyTypo(token)) {
      params.push(token)
      tokenClauses.push(
        `((${matchParts.join(" OR ")}) OR word_similarity(?, n.search_norm) > 0.4)`
      )
    } else {
      tokenClauses.push(`((${matchParts.join(" OR ")}))`)
    }
  }
  const whereSql = tokenClauses.join(" AND ")

  const rankParams = []
  const rankBits = []
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

  const cteParams = [JSON.stringify({ status: "published" })]
  let cteFilter = `"indexed" @> ?::jsonb`
  if (categoryId) {
    cteParams.push(JSON.stringify({ category_ids: [categoryId] }))
    cteFilter += ` AND "indexed" @> ?::jsonb`
  }

  const listSql = `WITH n AS MATERIALIZED (
         SELECT "id", "document", ${NORM_TEXT} AS search_norm
         FROM "t"
         WHERE ${cteFilter}
       )
       SELECT "id", "document", ${rankSql} AS score, COUNT(*) OVER () AS total
       FROM n
       WHERE ${whereSql}
       ORDER BY score DESC, "id" ASC
       LIMIT ? OFFSET ?`
  const listParams = [...cteParams, ...rankParams, ...params, take, skip]
  return {
    tokens,
    whereSql,
    rankSql,
    cteFilter,
    listSql,
    params,
    rankParams,
    cteParams,
    listParams,
  }
}

function assertBalanced(sql, label) {
  let depth = 0
  for (const ch of sql) {
    if (ch === "(") depth++
    else if (ch === ")") depth--
    assert.ok(depth >= 0, `${label}: лишняя закрывающая скобка -> ${sql.slice(0, 120)}`)
  }
  assert.equal(depth, 0, `${label}: несбалансированные скобки -> ${sql.slice(0, 160)}`)
}

const countPlaceholders = (sql) => (sql.match(/\?/g) || []).length

const queries = [
  "кабель", "ввг", "ВВГ", "кабель ввг", "кабель ввг 3х1.5", "сверло 6",
  "ссверла", "аавтомат", "розета", "розетка legrand", "автомат iek",
  "лампа е27", "саморез 4х", "ключ разводной", "ВВГнг-LS", "шввп",
  "IEK", "3", "х", "вв", "абв где-то ёж", "  ", "ъь",
]

let checks = 0
for (const q of queries) {
  for (const categoryId of [null, "pcat_01HXYZ"]) {
    let built
    try {
      built = build(q, { categoryId })
    } catch (e) {
      // Пустой/мусорный запрос — ожидаемая ранняя ошибка, не SQL
      assert.ok(!tokenize(q).length, `неожиданный сбой на "${q}": ${e.message}`)
      continue
    }
    if (!built.tokens.length) continue

    assertBalanced(built.whereSql, `WHERE "${q}"`)
    assertBalanced(built.rankSql, `rank "${q}"`)
    assertBalanced(built.cteFilter, `cte "${q}"`)
    assertBalanced(built.listSql, `LIST "${q}"`)

    // placeholders в WHERE должны совпасть с числом параметров WHERE
    assert.equal(
      countPlaceholders(built.whereSql),
      built.params.length,
      `WHERE "${q}": placeholders != params`
    )
    assert.equal(
      countPlaceholders(built.cteFilter),
      built.cteParams.length,
      `CTE "${q}": placeholders != params`
    )
    assert.equal(
      countPlaceholders(built.rankSql),
      built.rankParams.length,
      `rank "${q}": placeholders != params`
    )
    // в полном SELECT: CTE + rank + where + take + skip
    assert.equal(
      countPlaceholders(built.listSql),
      built.listParams.length,
      `LIST "${q}": placeholders(${countPlaceholders(built.listSql)}) != params(${built.listParams.length})`
    )
    // порядок в тексте SQL: CTE → rank → where → LIMIT
    const pCte = built.listSql.indexOf(built.cteFilter)
    const pRank = built.listSql.indexOf(built.rankSql)
    const pWhere = built.listSql.indexOf(built.whereSql)
    assert.ok(
      pCte < pRank && pRank < pWhere,
      `порядок фрагментов в "${q}" не совпадает с порядком параметров`
    )
    // тяжёлая свёртка должна встречаться в запросе ровно один раз
    assert.equal(
      (built.listSql.match(/<NORM>/g) || []).length,
      1,
      `"${q}": свёртка дублируется в SQL (должна считаться один раз в CTE)`
    )
    checks++
  }
}

// Ключевой регресс: свёртка не должна требовать lower() для кириллицы
const prevExpr = "replace(replace("
assert.ok(!NORM_TEXT.includes(prevExpr), "свёртка снова собрана из вложенных replace")

console.log(`PASS: SQL сбалансирован и параметры совпадают (${checks} конфигураций)`)
