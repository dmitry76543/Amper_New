/**
 * Проверка, что SQL-свёртка (translate/replace) эквивалентна JS-свёртке.
 *
 * Живого Postgres на машине нет, поэтому семантику SQL-выражения
 * воспроизводим в JS ровно теми же операциями: translate() и replace()
 * позиционные и не зависят от locale — значит результат детерминирован
 * и его можно сверять с foldSearchLatin на большом корпусе.
 *
 * Запуск: node scripts/test-search-fold-sql.mjs
 */
import assert from "node:assert/strict"

// --- копия JS-свёртки (источник: search-fold.ts) ---
const MULTI = [
  ["ж", "zh"], ["х", "h"], ["ц", "ts"], ["ч", "ch"],
  ["ш", "sh"], ["щ", "sch"], ["ю", "yu"], ["я", "ya"],
]
const SINGLE = [
  ["а", "a"], ["б", "b"], ["в", "v"], ["г", "g"], ["д", "d"], ["е", "e"],
  ["ё", "e"], ["з", "z"], ["и", "i"], ["й", "i"], ["к", "k"], ["л", "l"],
  ["м", "m"], ["н", "n"], ["о", "o"], ["п", "p"], ["р", "r"], ["с", "s"],
  ["т", "t"], ["у", "u"], ["ф", "f"], ["ъ", ""], ["ы", "y"], ["ь", ""],
  ["э", "e"],
]

function foldSearchLatin(value) {
  let out = String(value || "").toLowerCase()
  for (const [re, to] of MULTI) out = out.replaceAll(re, to)
  for (const [re, to] of SINGLE) out = out.replaceAll(re, to)
  return out
}

// --- копия SQL-выражения (источник: buildNormTextSql) ---
const CYR_UPPER = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ"
const CYR_LOWER = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя"
const SINGLE_FROM = "абвгдеёзийклмнопрстуфыэ"
const SINGLE_TO = "abvgdeeziiklmnoprstufye"

/** Эмуляция Postgres translate(): замена по позиции, лишние символы как есть */
function translate(str, from, to) {
  const map = new Map()
  for (let i = 0; i < from.length; i++) {
    // Повтор символа в `from` берёт ПОСЛЕДНЕЕ соответствие — как в Postgres
    map.set(from[i], to[i] ?? "")
  }
  let out = ""
  for (const ch of str) out += map.has(ch) ? map.get(ch) : ch
  return out
}

function replaceAll(str, from, to) {
  if (!from) return str
  return str.split(from).join(to)
}

function sqlFold(raw) {
  // lower(translate(col, CYR_UPPER, CYR_LOWER))
  let expr = translate(String(raw ?? ""), CYR_UPPER, CYR_LOWER).toLowerCase()
  // 8 многобуквенных замен
  for (const [from, to] of MULTI) expr = replaceAll(expr, from, to)
  // остальная кириллица 1:1
  expr = translate(expr, SINGLE_FROM, SINGLE_TO)
  // ъ и ь выбрасываются
  expr = replaceAll(expr, "ъ", "")
  expr = replaceAll(expr, "ь", "")
  return expr
}

assert.equal(CYR_UPPER.length, CYR_LOWER.length, "таблицы регистра разной длины")
assert.equal(SINGLE_FROM.length, SINGLE_TO.length, "1:1 таблицы разной длины")

// --- корпус: реальные формулировки каталога, регистр, коды, цифры ---
const cases = [
  "ВВГ", "ввг", "VVG", "ВВГнг", "ВВГнг-LS", "ПВС", "ПВСнг", "ШВВП", "NYM",
  "ВБбШв", "КГВВ", "ПУГВ", "3х1.5", "автомат 16", "кабель", "розетка",
  "выключатель", "узо", "лампа", "светильник", "провод", "гофра", "IEK",
  "Legrand", "ABB", "топор", "топоры", "Топор плотницкий", "сверло",
  "сверла", "дрель", "шуруповерт", "ключ разводной", "молоток", "отвертка",
  "пассатижи", "саморез", "шуруп", "гвоздь", "гвозди", "Гвозди строительные",
  "анкер", "дюбель", "болт", "гайка", "шайба", "перчатки", "ведро",
  "Кабель ВВГнг 3х1.5 vvg-ng-15", "МойСклад", "Ёмкость", "объём", "съезд",
  "Цинк", "цинковый", "Чугун", "чугунный", "Щиток", "ЩИТОК", "Юпитер",
  "Ящик", "ящик электрический", "Хомут", "хомут нейлоновый", "Шина",
  "ШВВП 2х0.75", "ЭП-125", "Эмаль ПФ-115", "ъь", "", "   ",
]

let checked = 0
for (const input of cases) {
  const js = foldSearchLatin(input)
  const sql = sqlFold(input)
  assert.equal(
    sql,
    js,
    `расхождение на "${input}": js="${js}" sql="${sql}"`
  )
  checked++
}

// --- алфавит: каждый символ по отдельности, в обоих регистрах ---
const alphabet = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя"
for (const ch of alphabet) {
  for (const variant of [ch, ch.toUpperCase(), `Товар ${ch}`, `${ch}-100`]) {
    assert.equal(
      sqlFold(variant),
      foldSearchLatin(variant),
      `расхождение на "${variant}"`
    )
    checked++
  }
}

// --- случайные строки из смешанных алфавитов и цифр ---
const pool = `${alphabet}${alphabet.toUpperCase()}abcdefghijklmnopqrstuvwxyz0123456789 -.,/`
let seed = 12345
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
for (let i = 0; i < 2000; i++) {
  let s = ""
  const len = Math.floor(rand() * 24)
  for (let j = 0; j < len; j++) {
    s += pool[Math.floor(rand() * pool.length)]
  }
  assert.equal(sqlFold(s), foldSearchLatin(s), `расхождение на "${s}"`)
  checked++
}

// --- что свёртка реально склеивает кириллицу и латиницу ---
assert.equal(sqlFold("ВВГ"), "vvg")
assert.equal(sqlFold("ввг"), "vvg")
assert.equal(sqlFold("VVG"), "vvg")
assert.ok(
  sqlFold("Кабель ВВГнг 3х1.5 vvg-ng-15").includes(sqlFold("ВВГ")),
  "ВВГ не находится в названии после свёртки"
)

console.log(`PASS: SQL-свёртка эквивалентна JS на ${checked} случаях`)
