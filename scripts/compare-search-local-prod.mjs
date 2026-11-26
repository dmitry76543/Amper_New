/**
 * Сравнение поиска локально и на Amvera (через витринный прокси).
 * Нужны: локальный backend на :9000 и apps/web/.env.local с publishable key.
 *
 * Запуск: node scripts/compare-search-local-prod.mjs
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const envLocal = fs.readFileSync(path.join(root, "apps/web/.env.local"), "utf8")
const pub = envLocal.match(/NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=(.+)/)?.[1]?.trim()
if (!pub) {
  console.error("Нет NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY в apps/web/.env.local")
  process.exit(1)
}

const LOCAL = "http://localhost:9000/store/catalog-search"
const PROD = "https://amper1.ru/api/medusa/store/catalog-search"

/** Расширенный набор: марки кабеля, электрика, крепёж, инструмент, опечатки */
const QUERIES = [
  // A марки кабеля / провода (кириллица и латиница)
  "ввг",
  "ВВГ",
  "VVG",
  "ВВГнг",
  "ПВС",
  "ПВСнг",
  "ШВВП",
  "шввп",
  "NYM",
  "ВБбШв",
  "КГВВ",
  "ПУГВ",
  "3х1.5",
  "автомат 16",
  // B электрика
  "кабель",
  "розетка",
  "выключатель",
  "автомат",
  "узо",
  "лампа",
  "светильник",
  "провод",
  "гофра",
  "IEK",
  "Legrand",
  "ABB",
  // C инструмент
  "топор",
  "сверло",
  "дрель",
  "шуруповерт",
  "ключ разводной",
  "молоток",
  "отвертка",
  "пассатижи",
  // D крепёж
  "саморез",
  "шуруп",
  "гвоздь",
  "гвозди",
  "анкер",
  "дюбель",
  "болт",
  "гайка",
  "шайба",
  // E хозтовары
  "перчатки",
  "ведро",
  // F составные
  "кабель ввг",
  "кабель ВВГ",
  "кабель шввп",
  "розетка legrand",
  "автомат iek",
  "лампа е27",
  "сверло 6",
  "саморез 4х",
  // G опечатки
  "ссверла",
  "аавтомат",
  "розета",
]

async function search(url, headers, q) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ q, pagination: { take: 5, skip: 0 } }),
  })
  const j = await r.json().catch(() => ({}))
  const meta = j.results?.[0]?.metadata
  return {
    status: r.status,
    count: meta?.count ?? null,
    tokens: meta?.tokens ?? null,
    err: j.message || null,
  }
}

function pad(s, n) {
  return String(s ?? "").padEnd(n)
}

const localH = { "x-publishable-api-key": pub }
const rows = []
const lines = []
const log = (line = "") => {
  console.log(line)
  lines.push(line)
}

log("Сравнение catalog-search: local vs amper1.ru")
log(new Date().toISOString())
log("")
log(
  pad("запрос", 22) +
    pad("local", 8) +
    pad("amvera", 8) +
    pad("отношение", 10) +
    "токены"
)
log("-".repeat(72))

for (const q of QUERIES) {
  const L = await search(LOCAL, localH, q)
  const P = await search(PROD, {}, q)
  const ratio =
    typeof L.count === "number" && typeof P.count === "number" && L.count > 0
      ? (P.count / L.count).toFixed(2)
      : "-"
  const flag =
    typeof L.count === "number" &&
    typeof P.count === "number" &&
    L.count >= 20 &&
    P.count / L.count < 0.35
      ? " ⚠"
      : ""
  rows.push({ q, L, P, ratio, flag })
  log(
    pad(q, 22) +
      pad(L.count ?? L.err ?? "err", 8) +
      pad(P.count ?? P.err ?? "err", 8) +
      pad(ratio + flag, 10) +
      (P.tokens || L.tokens || []).join(",")
  )
}

const warn = rows.filter((r) => r.flag)
log("")
log("Подозрительные (локаль ≥20 и Amvera <35% от локали): " + warn.length)
for (const r of warn) {
  log(`  - ${r.q}: local=${r.L.count} amvera=${r.P.count}`)
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const desktopLog = path.join(
  process.env.USERPROFILE || root,
  "Desktop",
  `amper-search-compare-${stamp}.txt`
)
fs.writeFileSync(desktopLog, lines.join("\n"), "utf8")
log("")
log("Лог сохранён: " + desktopLog)
