import { foldSearchLatin } from "../../api/store/catalog-search/search-fold"

/**
 * Логика разбора запроса и сопоставления — одна на два движка:
 * SQL-путь (запасной) и in-memory индекс (основной).
 *
 * Держим в одном месте, чтобы правила совпадения не разъехались:
 * именно расхождение «память находит не то, что SQL» было бы худшим багом.
 */

const MIN_TOKEN = 2
/** Опечатки только для длинных «буквенных» кусков — иначе AND разъезжается */
export const TYPO_MIN_TOKEN = 4
/**
 * Fuzzy только если в куске есть удвоение букв (ссверла).
 * На обычном «сверла» word_similarity сильно раздувает выдачу.
 */
export const TYPO_THRESHOLD = 0.4

/** Цифра «3» или код «А» — осмысленный кусок; короткий мусор отбрасываем */
export function isKeepableToken(token: string): boolean {
  if (!token) return false
  if (/^\d+$/.test(token)) return true
  return token.length >= MIN_TOKEN
}

/** Куски запроса: пробелы/запятые; цифры оставляем даже из 1 знака */
export function tokenize(q: string): string[] {
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
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * С начала слова: «топор» и «топорище» — да, «стопор» — нет.
 * После foldSearchLatin в тексте только латиница/цифры.
 */
export function wordPrefixPattern(variant: string): string {
  return `(^|[^a-z0-9])${escapeRegex(variant)}`
}

/** ссверла → сверла (убрать удвоенные буквы) */
export function collapseRepeats(token: string): string {
  return token.replace(/(.)\1+/gi, "$1")
}

/**
 * Варианты куска: как ввели + без удвоений.
 * Обрезку окончания (сверла→сверл) только для длинных слов —
 * иначе «раств»→«раст» цепляет «растений».
 */
export function tokenVariants(token: string): string[] {
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
export function isStrictToken(token: string): boolean {
  return /[0-9]/.test(token) || token.length < TYPO_MIN_TOKEN
}

/**
 * Soft-fuzzy только при удвоениях в длинных словах: ссверла, аавтомат.
 * Короткие коды вроде ШВВП→shvvp (две «v» из «ВВ») не считаем опечаткой:
 * иначе word_similarity цепляет «швейной» (shveinoi).
 */
export function allowFuzzyTypo(token: string): boolean {
  if (isStrictToken(token) || !/^[a-z]+$/i.test(token)) return false
  if (token.length < 6) return false
  return collapseRepeats(token) !== token
}

/** Одинарное условие по одному варианту: начало слова и (для кодов ≥3) подстрока */
export type VariantMatcher = {
  /** Регулярка «начало слова» — как `~ '(^|[^a-z0-9])token'` в SQL */
  prefix: RegExp
  /** Подстрока для буквенных кодов ≥3: «ВВП» находит «ШВВП» */
  substring: string | null
}

export type TokenMatcher = {
  token: string
  variants: VariantMatcher[]
  fuzzy: boolean
}

/** Готовит матчеры под запрос — один раз на запрос, не на строку */
export function buildMatchers(tokens: string[]): TokenMatcher[] {
  return tokens.map((token) => ({
    token,
    fuzzy: allowFuzzyTypo(token),
    variants: tokenVariants(token).map((variant) => ({
      prefix: new RegExp(wordPrefixPattern(variant)),
      substring:
        /^[a-z]+$/i.test(variant) && variant.length >= 3 ? variant : null,
    })),
  }))
}

/**
 * Совпадение одного куска. Порядок тот же, что в SQL:
 * (начало слова OR подстрока OR fuzzy).
 */
export function variantMatches(normText: string, matcher: VariantMatcher): boolean {
  if (matcher.prefix.test(normText)) return true
  if (matcher.substring && normText.includes(matcher.substring)) return true
  return false
}

/**
 * Триграммы для fuzzy-ветки.
 * Postgres считает `word_similarity(запрос, текст)` — наибольшее сходство
 * между триграммами запроса и непрерывным куском текста. Здесь то же самое,
 * но по границам слов: сравниваем кусок с каждым словом документа.
 */
function trigrams(value: string): Map<string, number> {
  const padded = `  ${value} `
  const out = new Map<string, number>()
  for (let i = 0; i < padded.length - 2; i++) {
    const gram = padded.slice(i, i + 3)
    out.set(gram, (out.get(gram) || 0) + 1)
  }
  return out
}

/**
 * Сходство двух множеств триграмм (формула pg_trgm similarity).
 * Возвращает 0..1, как `similarity()` в Postgres.
 */
export function trigramSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let shared = 0
  for (const [gram, countA] of a) {
    const countB = b.get(gram)
    if (countB) shared += Math.min(countA, countB)
  }
  let totalA = 0
  let totalB = 0
  for (const count of a.values()) totalA += count
  for (const count of b.values()) totalB += count
  if (totalA + totalB === 0) return 0
  return (2 * shared) / (totalA + totalB)
}

export function buildTokenTrigrams(token: string): Map<string, number> {
  return trigrams(token)
}

/** Ранг куска: начало слова 1.0, подстрока 0.7, иначе 0.2 — как в SQL */
export function rankFor(normText: string, matcher: TokenMatcher): number {
  const prefix = new RegExp(wordPrefixPattern(matcher.token))
  if (prefix.test(normText)) return 1.0
  const substring =
    /^[a-z]+$/i.test(matcher.token) && matcher.token.length >= 3
      ? matcher.token
      : null
  if (substring && normText.includes(substring)) return 0.7
  return 0.2
}
