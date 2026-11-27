/**
 * Свёртка поискового текста к латинице.
 * Нужна, чтобы «ВВГ» (кириллица) находило handle/артикул `vvg` и наоборот.
 */

const MULTI: Array<[RegExp, string]> = [
  [/ж/g, "zh"],
  [/х/g, "h"],
  [/ц/g, "ts"],
  [/ч/g, "ch"],
  [/ш/g, "sh"],
  [/щ/g, "sch"],
  [/ю/g, "yu"],
  [/я/g, "ya"],
]

const SINGLE: Array<[RegExp, string]> = [
  [/а/g, "a"],
  [/б/g, "b"],
  [/в/g, "v"],
  [/г/g, "g"],
  [/д/g, "d"],
  [/е/g, "e"],
  [/ё/g, "e"],
  [/з/g, "z"],
  [/и/g, "i"],
  [/й/g, "i"],
  [/к/g, "k"],
  [/л/g, "l"],
  [/м/g, "m"],
  [/н/g, "n"],
  [/о/g, "o"],
  [/п/g, "p"],
  [/р/g, "r"],
  [/с/g, "s"],
  [/т/g, "t"],
  [/у/g, "u"],
  [/ф/g, "f"],
  [/ъ/g, ""],
  [/ы/g, "y"],
  [/ь/g, ""],
  [/э/g, "e"],
]

/** Кириллица: верхний → нижний регистр (без зависимости от locale) */
const CYR_UPPER = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ"
const CYR_LOWER = "абвгдеёжзийклмнопрстуфхцчшщъыьэюя"

/**
 * 1:1 кириллица → латиница (кроме многобуквенных и «ъ»/«ь»).
 * Порядок символов обязан совпадать между строками: translate() сопоставляет
 * их по позиции. «й» → «i» (не «j») — иначе «МойСклад» разойдётся с JS-свёрткой.
 */
const SINGLE_FROM = "абвгдеёзийклмнопрстуфыэ"
const SINGLE_TO = "abvgdeeziiklmnoprstufye"

/** Нижний регистр + кириллица→латиница (как в handle товаров) */
export function foldSearchLatin(value: string): string {
  let out = String(value || "").toLowerCase()
  for (const [re, to] of MULTI) out = out.replace(re, to)
  for (const [re, to] of SINGLE) out = out.replace(re, to)
  return out
}

/** SQL: те же 8 многобуквенных замен, что и в MULTI */
const MULTI_SQL: Array<[string, string]> = [
  ["ж", "zh"],
  ["х", "h"],
  ["ц", "ts"],
  ["ч", "ch"],
  ["ш", "sh"],
  ["щ", "sch"],
  ["ю", "yu"],
  ["я", "ya"],
]

/**
 * SQL-выражение той же свёртки для колонки search_text.
 * После fold граница слова — только латиница/цифры.
 *
 * Важно: не полагаемся на Postgres lower() для кириллицы — на Amvera
 * (locale C) lower('Г') может остаться «Г», и «Гвозди» не находятся,
 * тогда как строчные «винтовые»/«цинк» в том же названии находятся.
 * Поэтому регистр снимаем через translate() с явной таблицей символов.
 *
 * Раньше здесь было 66 вложенных replace(): выражение длиной 1280 символов,
 * а в запросе оно повторялось до 6 раз на токен — поиск уходил в минуты.
 * translate() даёт тот же результат за 12 операций.
 */
export function buildNormTextSql(columnSql = `"search_text"`): string {
  // 1. Кириллица в нижний регистр + ASCII в нижний регистр.
  let expr = `lower(translate(${columnSql}, '${CYR_UPPER}', '${CYR_LOWER}'))`
  // 2. Многобуквенные замены (ж → zh, …).
  for (const [from, to] of MULTI_SQL) {
    expr = `replace(${expr}, '${from}', '${to}')`
  }
  // 3. Остальная кириллица 1:1.
  expr = `translate(${expr}, '${SINGLE_FROM}', '${SINGLE_TO}')`
  // 4. «ъ» и «ь» выбрасываются (translate так не умеет).
  expr = `replace(${expr}, 'ъ', '')`
  expr = `replace(${expr}, 'ь', '')`
  return expr
}
