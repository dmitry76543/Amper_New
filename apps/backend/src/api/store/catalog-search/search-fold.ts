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

/** Нижний регистр + кириллица→латиница (как в handle товаров) */
export function foldSearchLatin(value: string): string {
  let out = String(value || "").toLowerCase()
  for (const [re, to] of MULTI) out = out.replace(re, to)
  for (const [re, to] of SINGLE) out = out.replace(re, to)
  return out
}

/**
 * SQL-выражение той же свёртки для колонки search_text.
 * После fold граница слова — только латиница/цифры.
 *
 * Важно: не полагаемся на Postgres lower() для кириллицы — на Amvera
 * (locale C) lower('Г') может остаться «Г», и «Гвозди» не находятся,
 * тогда как строчные «винтовые»/«цинк» в том же названии находятся.
 */
export function buildNormTextSql(columnSql = `"search_text"`): string {
  let expr = columnSql
  const upperToLower: Array<[string, string]> = [
    ["А", "а"],
    ["Б", "б"],
    ["В", "в"],
    ["Г", "г"],
    ["Д", "д"],
    ["Е", "е"],
    ["Ё", "ё"],
    ["Ж", "ж"],
    ["З", "з"],
    ["И", "и"],
    ["Й", "й"],
    ["К", "к"],
    ["Л", "л"],
    ["М", "м"],
    ["Н", "н"],
    ["О", "о"],
    ["П", "п"],
    ["Р", "р"],
    ["С", "с"],
    ["Т", "т"],
    ["У", "у"],
    ["Ф", "ф"],
    ["Х", "х"],
    ["Ц", "ц"],
    ["Ч", "ч"],
    ["Ш", "ш"],
    ["Щ", "щ"],
    ["Ъ", "ъ"],
    ["Ы", "ы"],
    ["Ь", "ь"],
    ["Э", "э"],
    ["Ю", "ю"],
    ["Я", "я"],
  ]
  for (const [from, to] of upperToLower) {
    expr = `replace(${expr}, '${from}', '${to}')`
  }
  // Латиница и прочий ASCII
  expr = `lower(${expr})`
  const pairs: Array<[string, string]> = [
    ["ж", "zh"],
    ["х", "h"],
    ["ц", "ts"],
    ["ч", "ch"],
    ["ш", "sh"],
    ["щ", "sch"],
    ["ю", "yu"],
    ["я", "ya"],
    ["а", "a"],
    ["б", "b"],
    ["в", "v"],
    ["г", "g"],
    ["д", "d"],
    ["е", "e"],
    ["ё", "e"],
    ["з", "z"],
    ["и", "i"],
    ["й", "i"],
    ["к", "k"],
    ["л", "l"],
    ["м", "m"],
    ["н", "n"],
    ["о", "o"],
    ["п", "p"],
    ["р", "r"],
    ["с", "s"],
    ["т", "t"],
    ["у", "u"],
    ["ф", "f"],
    ["ъ", ""],
    ["ы", "y"],
    ["ь", ""],
    ["э", "e"],
  ]
  for (const [from, to] of pairs) {
    expr = `replace(${expr}, '${from}', '${to}')`
  }
  return expr
}
