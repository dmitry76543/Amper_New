import Medusa from "@medusajs/js-sdk"
import { visibleCategories, type StoreCategory } from "./catalog-nav"

const backendUrl =
  typeof window !== "undefined"
    ? `${window.location.origin}/api/medusa`
    : process.env.MEDUSA_BACKEND_URL ||
      process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL ||
      "http://localhost:9000"

export const medusa = new Medusa({
  baseUrl: backendUrl,
  publishableKey: process.env.MEDUSA_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
  debug: process.env.NODE_ENV === "development",
  auth: {
    type: "jwt",
  },
})

export type StoreProduct = {
  id: string
  title: string
  handle: string
  description?: string | null
  thumbnail?: string | null
  images?: Array<{ id?: string; url: string }> | null
  metadata?: Record<string, unknown> | null
  variants?: Array<{
    id: string
    title?: string
    sku?: string | null
    manage_inventory?: boolean
    allow_backorder?: boolean
    inventory_quantity?: number | null
    calculated_price?: {
      calculated_amount?: number
      currency_code?: string
    } | null
    metadata?: Record<string, unknown> | null
  }>
}

/**
 * Поля товара для витрины: цена, uom и остаток.
 * Без +metadata / *variants.metadata единицы и артикулы МойСклад пропадут
 * (типичный баг: в корзине «шт» вместо «м»).
 */
export const STORE_PRODUCT_FIELDS =
  "+metadata,*variants,*variants.metadata,+variants.inventory_quantity,+variants.manage_inventory,+variants.allow_backorder,*images,*thumbnail"

/**
 * Облегчённый набор для сетки каталога и поиска: карточка показывает только
 * первое фото и первый вариант, поэтому `*images` (все фото каждого товара)
 * здесь лишний — на 48 товарах это заметный вес и время ответа.
 * Для страницы товара остаётся полный STORE_PRODUCT_FIELDS.
 */
export const STORE_CARD_FIELDS =
  "+metadata,*variants,+variants.inventory_quantity,+variants.manage_inventory,+variants.allow_backorder,*thumbnail"

/** Остаток первого варианта; null — остаток не учитывается */
export function productInventoryQty(
  product: StoreProduct | null | undefined
): number | null {
  const v = product?.variants?.[0]
  if (!v) return 0
  if (v.manage_inventory === false || v.allow_backorder) return null
  if (typeof v.inventory_quantity === "number") {
    return Math.max(0, Math.floor(v.inventory_quantity))
  }
  return 0
}

export function productInStock(product: StoreProduct | null | undefined): boolean {
  const qty = productInventoryQty(product)
  return qty === null || qty > 0
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || ""
  if (typeof err === "string") return err
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>
    if (typeof o.message === "string") return o.message
    if (typeof o.type === "string") return o.type
  }
  return String(err || "")
}

/** Ошибки корзины/остатка — по-русски */
export function translateInventoryError(
  err: unknown,
  available?: number | null
): string {
  const msg = errorText(err)
  const inventoryFail =
    /required inventory|insufficient_inventory|not have the required|inventory_item/i.test(
      msg
    )
  if (inventoryFail) {
    if (typeof available === "number") {
      if (available <= 0) return "Нет в наличии"
      return `В наличии только ${available}`
    }
    return "В наличии меньше, чем запрошено"
  }
  if (!msg || msg === "Failed to fetch" || /fetch failed/i.test(msg)) {
    return "Не удалось выполнить запрос. Попробуйте ещё раз."
  }
  return msg
}

/** URL картинок для галереи: images[], иначе thumbnail */
export function productImageUrls(product: StoreProduct): string[] {
  const fromImages = (product.images || [])
    .map((img) => img?.url)
    .filter((url): url is string => Boolean(url))
  if (fromImages.length) return fromImages
  if (product.thumbnail) return [product.thumbnail]
  return []
}

/** Цена в рублях: calculated_price в Medusa 2 — уже рубли; metadata — копейки МойСклад */
export function productPriceRub(product: StoreProduct): number {
  const variant = product.variants?.[0]
  const calculated = variant?.calculated_price?.calculated_amount
  if (typeof calculated === "number") return calculated
  const metaPrice = Number(variant?.metadata?.moysklad_price_kopecks || 0)
  if (metaPrice > 0) return metaPrice / 100
  return 0
}

export function formatRub(amount: number): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(amount)
}

/** Единица из metadata.moysklad_uom: сначала товар, потом вариант (как на карточке) */
export function resolveMoyskladUom(
  ...sources: Array<Record<string, unknown> | null | undefined>
): string {
  for (const meta of sources) {
    const uom = String(meta?.moysklad_uom || "").trim()
    if (uom) return uom
  }
  return "шт"
}

/** Единица измерения из МойСклад (шт / м / упак…), иначе шт */
export function productUom(
  product: {
    metadata?: Record<string, unknown> | null
    variants?: Array<{ metadata?: Record<string, unknown> | null }>
  } | null | undefined
): string {
  return resolveMoyskladUom(
    product?.metadata,
    product?.variants?.[0]?.metadata
  )
}

/** Подпись цены: «за шт», «за м» */
export function pricePerUomLabel(uom: string): string {
  const unit = (uom || "шт").trim() || "шт"
  return `за ${unit}`
}

export type StoreCategoryRow = StoreCategory

/** Сколько живёт снимок дерева категорий (мс). Переопределяется CATEGORIES_CACHE_TTL_MS. */
const CATEGORY_CACHE_TTL_MS = 5 * 60 * 1000

/** Страховка от «зацикливания» пагинации, если count от бэкенда разошёлся с фактом */
const CATEGORY_PAGE_LIMIT = 20

/**
 * Дерево категорий меняется раз в сутки (ночной синк МойСклад).
 * Поэтому кэшируем полный список на процесс: раньше /catalog на КАЖДЫЙ рендер
 * последовательно выкачивал все страницы, плюс отдельно это же делал хедер —
 * на медленном бэкенде это давало десятки секунд ещё до самого поиска.
 */
let categoryCache: { at: number; all: StoreCategory[] } | null = null

async function loadAllCategories(): Promise<StoreCategory[]> {
  const categories: StoreCategory[] = []
  for (let offset = 0, page = 0; page < CATEGORY_PAGE_LIMIT; page++, offset += 100) {
    const { product_categories, count } = await medusa.store.category.list({
      limit: 100,
      offset,
      fields: "id,name,handle,parent_category_id",
    })
    const chunk = (product_categories || []) as StoreCategory[]
    categories.push(...chunk)
    if (chunk.length < 100) break
    if (typeof count === "number" && categories.length >= count) break
  }
  return categories
}

/** Активные категории витрины (из папок МойСклад) */
export async function listStoreCategories(rootsOnly = false): Promise<StoreCategoryRow[]> {
  const now = Date.now()
  const ttl = Number(process.env.CATEGORIES_CACHE_TTL_MS) || CATEGORY_CACHE_TTL_MS
  if (!categoryCache || now - categoryCache.at > ttl) {
    try {
      categoryCache = { at: now, all: await loadAllCategories() }
    } catch (error) {
      // Отдаём прошлый снимок, если сеть/бэкенд подвели — лучше старое меню, чем пустое
      if (!categoryCache) throw error
      categoryCache = { ...categoryCache, at: now }
    }
  }
  const visible = visibleCategories(categoryCache.all)
  return rootsOnly ? visible.filter((category) => !category.parent_category_id) : visible
}
