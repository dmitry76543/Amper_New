/**
 * Проверка свёртки поиска: ВВГ ↔ vvg, топоры → topor…
 * Логика должна совпадать с apps/backend/src/api/store/catalog-search/search-fold.ts
 * Запуск: node scripts/test-catalog-search-fold.mjs
 */
import assert from "node:assert/strict"

function foldSearchLatin(value) {
  let out = String(value || "").toLowerCase()
  const multi = [
    [/ж/g, "zh"],
    [/х/g, "h"],
    [/ц/g, "ts"],
    [/ч/g, "ch"],
    [/ш/g, "sh"],
    [/щ/g, "sch"],
    [/ю/g, "yu"],
    [/я/g, "ya"],
  ]
  const single = [
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
  for (const [re, to] of multi) out = out.replace(re, to)
  for (const [re, to] of single) out = out.replace(re, to)
  return out
}

assert.equal(foldSearchLatin("ВВГ"), "vvg")
assert.equal(foldSearchLatin("ввг"), "vvg")
assert.equal(foldSearchLatin("VVG"), "vvg")
assert.equal(foldSearchLatin("ВВГнг"), "vvgng")
assert.equal(foldSearchLatin("топоры"), "topory")
assert.equal(foldSearchLatin("Топор плотницкий"), "topor plotnitskii")

const indexBlob = foldSearchLatin("Кабель ВВГнг 3х1.5 vvg-ng-15")
const query = foldSearchLatin("ВВГ")
assert.ok(indexBlob.includes(query), `index="${indexBlob}" query="${query}"`)

const axesIndex = foldSearchLatin("Топор плотницкий 800г")
const axesQuery = foldSearchLatin("топоры")
assert.ok(
  axesIndex.includes(axesQuery.slice(0, -1)),
  `axes index="${axesIndex}" stem="${axesQuery.slice(0, -1)}"`
)

console.log("PASS: ВВГ/vvg/VVG и топоры сходятся после foldSearchLatin")
