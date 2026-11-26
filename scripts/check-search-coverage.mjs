/**
 * Сверка: товары в Medusa vs документы поискового индекса.
 * DATABASE_URL берётся из apps/backend/.env (в консоль не печатается).
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import pg from "pg"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const env = fs.readFileSync(path.join(root, "apps/backend/.env"), "utf8")
const url = env.match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim()
if (!url) {
  console.error("Нет DATABASE_URL в apps/backend/.env")
  process.exit(1)
}

const client = new pg.Client({ connectionString: url })
await client.connect()

const tables = await client.query(`
  SELECT tablename
  FROM pg_tables
  WHERE schemaname = 'public'
    AND (
      tablename ILIKE '%search%'
      OR tablename ILIKE '%product%'
      OR tablename ILIKE '%index%'
    )
  ORDER BY 1
`)
console.log("Таблицы:", tables.rows.map((r) => r.tablename).join(", ") || "(нет)")

async function safeCount(sql, label) {
  try {
    const r = await client.query(sql)
    const n = Number(r.rows[0]?.n ?? r.rows[0]?.count ?? 0)
    console.log(`${label}: ${n}`)
    return n
  } catch (e) {
    console.log(`${label}: ошибка (${e.message.split("\n")[0]})`)
    return null
  }
}

const products = await safeCount(
  `SELECT COUNT(*)::int AS n FROM product WHERE deleted_at IS NULL`,
  "Товары product (не удалённые)"
)
await safeCount(
  `SELECT COUNT(*)::int AS n FROM product WHERE deleted_at IS NULL AND status = 'published'`,
  "Товары published"
)

for (const t of tables.rows.map((r) => r.tablename)) {
  if (/search/i.test(t)) {
    await safeCount(`SELECT COUNT(*)::int AS n FROM "${t}"`, `Строк в ${t}`)
  }
}

for (const t of ["search_pg_product_v2", "search_pg_product_v3"]) {
  try {
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = $1 ORDER BY ordinal_position`,
      [t]
    )
    console.log(
      `Колонки ${t}:`,
      cols.rows.map((x) => x.column_name).join(", ") || "(нет)"
    )
  } catch {
    /* нет таблицы */
  }
}

try {
  const idx = await client.query(
    `SELECT id, name, is_current, version FROM search_postgres_index`
  )
  console.log("search_postgres_index:", JSON.stringify(idx.rows))
} catch (e) {
  try {
    const idx = await client.query(`SELECT * FROM search_postgres_index LIMIT 5`)
    console.log(
      "search_postgres_index sample:",
      JSON.stringify(idx.rows).slice(0, 500)
    )
  } catch (e2) {
    console.log("search_postgres_index:", e2.message.split("\n")[0])
  }
}

// Эвристика «действительности» по title для нескольких запросов
const samples = [
  ["лампа", 675],
  ["розетка", 734],
  ["ВВГ", 48],
  ["сверло", 562],
  ["ПВС", 86],
  ["гофра", 0],
  ["молоток", 51],
  ["перчатки", 39],
]
console.log(
  "\nСверка: title ILIKE (published) vs count поиска после reindex:"
)
console.log(
  "  (ILIKE только по названию; поиск ещё смотрит описание/артикул — может быть больше)"
)
for (const [q, searchCount] of samples) {
  const like = `%${q}%`
  const r = await client.query(
    `SELECT COUNT(*)::int AS n
     FROM product
     WHERE deleted_at IS NULL
       AND status = 'published'
       AND title ILIKE $1`,
    [like]
  )
  const titleN = r.rows[0].n
  const ratio =
    titleN > 0 ? ((searchCount / titleN) * 100).toFixed(0) + "%" : "—"
  console.log(
    `  ${q}: title=${titleN}, search=${searchCount}, search/title≈${ratio}`
  )
}

await client.end()
console.log("\nГотово.")
