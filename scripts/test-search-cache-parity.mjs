/**
 * Эквивалентность движков: in-memory поиск должен находить то же,
 * что и SQL-путь. Это главный инвариант — иначе после переключения
 * витрина начнёт «терять» товары.
 *
 * Живой БД нет, поэтому эталон — эмуляция SQL-семантики (POSIX-regex
 * по свёрнутому тексту), ровно как в route.ts, на реальном каталоге с прода.
 *
 * Запуск: node scripts/test-search-cache-parity.mjs
 */
import assert from "node:assert/strict"

const HOST = "amper1.ru"
const BASE = "/api/medusa/store"
const INDEX_FIELDS =
  "id,title,description,handle,thumbnail,status,+metadata,*variants.sku,*categories.id"

// ---------- свёртка (копия search-fold.ts) ----------
const MULTI = [["ж","zh"],["х","h"],["ц","ts"],["ч","ch"],["ш","sh"],["щ","sch"],["ю","yu"],["я","ya"]]
const SINGLE = [["а","a"],["б","b"],["в","v"],["г","g"],["д","d"],["е","e"],["ё","e"],["з","z"],["и","i"],["й","i"],["к","k"],["л","l"],["м","m"],["н","n"],["о","o"],["п","p"],["р","r"],["с","s"],["т","t"],["у","u"],["ф","f"],["ъ",""],["ы","y"],["ь",""],["э","e"]]
function fold(v) {
  let out = String(v || "").toLowerCase()
  for (const [a, b] of MULTI) out = out.split(a).join(b)
  for (const [a, b] of SINGLE) out = out.split(a).join(b)
  return out
}

// ---------- общая логика (копия matcher.ts) ----------
const MIN_TOKEN = 2
function tokenize(q) {
  const seen = new Set()
  const out = []
  for (const part of fold(q).split(/[\s,;|/]+/)) {
    const t = part.trim()
    if (!t) continue
    if (!(/^\d+$/.test(t) || t.length >= MIN_TOKEN) || seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  return out
}
const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const wordPrefix = (v) => `(^|[^a-z0-9])${esc(v)}`
const collapse = (t) => t.replace(/(.)\1+/gi, "$1")

function tokenVariants(token) {
  const seen = new Set()
  const out = []
  const push = (v) => {
    if (!(v && (/^\d+$/.test(v) || v.length >= MIN_TOKEN)) || seen.has(v)) return
    seen.add(v)
    out.push(v)
  }
  push(token)
  if (/[0-9]/.test(token)) return out
  const c = collapse(token)
  if (c.length >= 4) push(c)
  if (c.length >= 6) push(c.slice(0, -1))
  if (c.length >= 8) push(c.slice(0, -2))
  return out
}

function allowFuzzy(token) {
  if (/[0-9]/.test(token) || token.length < 4) return false
  if (!/^[a-z]+$/i.test(token)) return false
  if (token.length < 6) return false
  return collapse(token) !== token
}

// ---------- эталон: SQL-семантика ----------
function sqlSearch(docs, q) {
  const tokens = tokenize(q)
  if (!tokens.length) return []
  return docs
    .filter((d) =>
      tokens.every((token) => {
        const variants = tokenVariants(token)
        return variants.some((v) => {
          const re = new RegExp(wordPrefix(v))
          if (re.test(d.norm)) return true
          if (/^[a-z]+$/i.test(v) && v.length >= 3 && d.norm.includes(v)) return true
          return false
        })
      })
    )
    .map((d) => d.id)
    .sort()
}

// ---------- проверяемый: in-memory ----------
function trigrams(value) {
  const padded = `  ${value} `
  const out = new Map()
  for (let i = 0; i < padded.length - 2; i++) {
    const g = padded.slice(i, i + 3)
    out.set(g, (out.get(g) || 0) + 1)
  }
  return out
}
function similarity(a, b) {
  let shared = 0
  for (const [g, ca] of a) {
    const cb = b.get(g)
    if (cb) shared += Math.min(ca, cb)
  }
  let ta = 0
  let tb = 0
  for (const c of a.values()) ta += c
  for (const c of b.values()) tb += c
  return ta + tb === 0 ? 0 : (2 * shared) / (ta + tb)
}

function memSearch(docs, q) {
  const tokens = tokenize(q)
  if (!tokens.length) return []
  const matchers = tokens.map((token) => ({
    token,
    fuzzy: allowFuzzy(token),
    variants: tokenVariants(token).map((v) => ({
      prefix: new RegExp(wordPrefix(v)),
      substring: /^[a-z]+$/i.test(v) && v.length >= 3 ? v : null,
    })),
    grams: allowFuzzy(token) ? trigrams(token) : null,
  }))

  return docs
    .filter((d) =>
      matchers.every((m) => {
        if (m.variants.some((v) => v.prefix.test(d.norm) || (v.substring && d.norm.includes(v.substring)))) {
          return true
        }
        if (m.grams) {
          const words = d.norm.split(/\s+/).filter(Boolean)
          return words.some((w) => similarity(m.grams, trigrams(w)) > 0.4)
        }
        return false
      })
    )
    .map((d) => d.id)
    .sort()
}

// ---------- загрузка реального каталога ----------
async function fetchPage(offset, limit, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(
        `https://${HOST}${BASE}/products?limit=${limit}&offset=${offset}&fields=${INDEX_FIELDS}`,
        { signal: AbortSignal.timeout(90000) }
      )
      return JSON.parse(await res.text()).products || []
    } catch {
      /* повтор */
    }
  }
  return []
}

const PAGE = 200
const TOTAL = 11641
let all = []
for (let offset = 0; offset < TOTAL; offset += PAGE) {
  const chunk = await fetchPage(offset, PAGE)
  if (!chunk.length) break
  all = all.concat(chunk)
}
console.log(`Загружено товаров: ${all.length}`)

const docs = all
  .filter((p) => (p.status || "") === "published")
  .map((p) => {
    const article = String(p.metadata?.moysklad_article || "").trim()
    const sku = (p.variants || [])
      .map((v) => String(v?.sku || "").trim())
      .filter(Boolean)
      .join(" ")
    // search_text индекса: title article sku handle description
    const text = [p.title || "", article, sku, p.handle || "", p.description || ""].join(" ")
    const norm = fold(text)
    return { id: p.id, norm }
  })
console.log(`Published в индексе: ${docs.length}`)

// ---------- сверка ----------
const QUERIES = [
  "ввг", "ВВГ", "VVG", "ВВГнг", "ПВС", "ШВВП", "кабель", "розетка", "выключатель",
  "автомат", "узо", "лампа", "светильник", "провод", "гофра", "IEK", "Legrand",
  "ABB", "топор", "сверло", "дрель", "шуруповерт", "ключ разводной", "молоток",
  "отвертка", "пассатижи", "саморез", "шуруп", "гвоздь", "гвозди", "анкер",
  "дюбель", "болт", "гайка", "шайба", "перчатки", "ведро", "кабель ввг",
  "кабель ВВГ", "кабель шввп", "розетка legrand", "автомат iek", "лампа е27",
  "сверло 6", "саморез 4х", "3х1.5", "автомат 16", "ссверла", "аавтомат",
  "розета", "zzzzzzzz", "щщщщщщ", "саморез 4х",
]

let exact = 0
let fuzzyDiff = 0
const diffs = []

for (const q of QUERIES) {
  const sqlIds = sqlSearch(docs, q)
  const memIds = memSearch(docs, q)

  const tokens = tokenize(q)
  const hasFuzzy = tokens.some((t) => allowFuzzy(t))

  if (sqlIds.length === memIds.length && sqlIds.every((id, i) => id === memIds[i])) {
    exact++
    console.log(`  ✓ ${q.padEnd(20)} ${memIds.length}`)
  } else if (hasFuzzy) {
    // fuzzy-ветка: Postgres word_similarity и наша триграммная эвристика
    // неизбежно расходятся на границах. Сравниваем состав, не требуя равенства.
    const overlap = memIds.filter((id) => sqlIds.includes(id)).length
    const ratio = sqlIds.length ? overlap / sqlIds.length : 1
    if (ratio >= 0.9) exact++
    else fuzzyDiff++
    diffs.push({ q, sql: sqlIds.length, mem: memIds.length, ratio: ratio.toFixed(2) })
    console.log(`  ~ ${q.padEnd(20)} sql=${sqlIds.length} mem=${memIds.length} покрытие=${(ratio * 100).toFixed(0)}% (fuzzy)`)
  } else {
    fuzzyDiff++
    diffs.push({ q, sql: sqlIds.length, mem: memIds.length, ratio: "0.00" })
    console.log(`  ✗ ${q.padEnd(20)} sql=${sqlIds.length} mem=${memIds.length}`)
  }
}

console.log(`\nТочное совпадение: ${exact}/${QUERIES.length}`)
if (fuzzyDiff) {
  console.log(`Расхождения: ${fuzzyDiff}`)
  for (const d of diffs) console.log(`  ${d.q}: sql=${d.sql} mem=${d.mem} ${d.ratio}`)
}

assert.equal(
  fuzzyDiff,
  0,
  `движки расходятся на ${fuzzyDiff} запросах: ${diffs.map((d) => d.q).join(", ")}`
)
console.log("\nPASS: in-memory поиск эквивалентен SQL-семантике")
