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
 */
export function buildNormTextSql(columnSql = `"search_text"`): string {
  let expr = `lower(${columnSql})`
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
