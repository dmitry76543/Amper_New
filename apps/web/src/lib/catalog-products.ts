import {
  STORE_CARD_FIELDS,
  medusa,
  productInStock,
  productPriceRub,
  type StoreProduct,
} from "@/lib/medusa"

/** Размер порции каталога / поиска (infinite scroll) */
export const CATALOG_PAGE_SIZE = 48

/** Короче этого поиск не запускаем — слишком шумно на большой базе */
export const SEARCH_MIN_QUERY_LENGTH = 2

export type CatalogQuery = {
  q?: string
  categoryId?: string
  max?: string
  sort?: string
  stock?: string
  offset?: number
  limit?: number
  /** Отмена: при быстром вводе старые поиски должны перестать занимать бэкенд */
  signal?: AbortSignal
}

export type CatalogPageResult = {
  products: StoreProduct[]
  /** Число до клиентских фильтров цены/наличия */
  total: number
  offset: number
  limit: number
}

function normalizeQuery(q?: string): string {
  return (q || "").trim()
}

export function isSearchQuery(q?: string): boolean {
  return normalizeQuery(q).length >= SEARCH_MIN_QUERY_LENGTH
}

export function sortCatalogProducts(
  list: StoreProduct[],
  sort: string | undefined
): StoreProduct[] {
  if (sort === "low") {
    return [...list].sort((a, b) => productPriceRub(a) - productPriceRub(b))
  }
  if (sort === "high") {
    return [...list].sort((a, b) => productPriceRub(b) - productPriceRub(a))
  }
  return list
}

/** Фильтры цены и наличия на уже загруженной порции */
export function applyCatalogFilters(
  list: StoreProduct[],
  filters: { max?: string; stock?: string; sort?: string }
): StoreProduct[] {
  let products = list
  if (filters.max && filters.max !== "any") {
    const maxRub = Number(filters.max)
    if (Number.isFinite(maxRub)) {
      products = products.filter((product) => {
        const price = productPriceRub(product)
        return price > 0 && price <= maxRub
      })
    }
  }
  if (filters.stock === "in") {
    products = products.filter((product) => productInStock(product))
  }
  return sortCatalogProducts(products, filters.sort)
}

type SearchHit = {
  id?: string
  document?: { id?: string } | null
}

type SearchResponse = {
  results?: Array<{
    hits?: SearchHit[]
    metadata?: { count?: number; skip?: number; take?: number }
  }>
}

async function loadProductsByIds(ids: string[]): Promise<StoreProduct[]> {
  if (!ids.length) return []
  const { products } = await medusa.store.product.list({
    id: ids,
    limit: ids.length,
    fields: STORE_CARD_FIELDS,
  })
  const byId = new Map(
    ((products || []) as StoreProduct[]).map((product) => [product.id, product])
  )
  // Сохраняем порядок релевантности из поиска
  return ids
    .map((id) => byId.get(id))
    .filter((product): product is StoreProduct => Boolean(product))
}

/** Поиск: частичные слова (AND) + опечатки; запасные пути при сбое индекса */
async function searchProductsPage(
  query: CatalogQuery
): Promise<CatalogPageResult> {
  const q = normalizeQuery(query.q)
  const limit = query.limit ?? CATALOG_PAGE_SIZE
  const offset = query.offset ?? 0

  try {
    // Свой маршрут: все куски запроса сразу + trigram-опечатки
    const data = (await medusa.client.fetch(`/store/catalog-search`, {
      method: "POST",
      signal: query.signal,
      body: {
        q,
        category_id: query.categoryId || undefined,
        pagination: { take: limit, skip: offset },
      },
    })) as SearchResponse

    const result = data.results?.[0]
    const ids = (result?.hits || [])
      .map((hit) => hit.document?.id || hit.id)
      .filter((id): id is string => Boolean(id))
    const products = await loadProductsByIds(ids)
    return {
      products,
      total:
        typeof result?.metadata?.count === "number"
          ? result.metadata.count
          : products.length,
      offset,
      limit,
    }
  } catch (error) {
    // Отменённый запрос — это не сбой: не ходим в запасной путь,
    // иначе каждый брошенный символ запускал бы ещё и запрос к Medusa.
    if (query.signal?.aborted) throw error
    // Без мягкого /store/search: typo_tolerance там размывает AND и пропускает лишнее.
    // Запас только list?q= (целые слова Medusa), пока не поднят catalog-search.
    const { products, count } = await medusa.store.product.list({
      q,
      limit,
      offset,
      category_id: query.categoryId ? [query.categoryId] : undefined,
      fields: STORE_CARD_FIELDS,
    })
    return {
      products: (products || []) as StoreProduct[],
      total: typeof count === "number" ? count : (products || []).length,
      offset,
      limit,
    }
  }
}

async function listProductsPage(
  query: CatalogQuery
): Promise<CatalogPageResult> {
  const limit = query.limit ?? CATALOG_PAGE_SIZE
  const offset = query.offset ?? 0
  const { products, count } = await medusa.store.product.list({
    limit,
    offset,
    category_id: query.categoryId ? [query.categoryId] : undefined,
    fields: STORE_CARD_FIELDS,
  })
  return {
    products: (products || []) as StoreProduct[],
    total: typeof count === "number" ? count : (products || []).length,
    offset,
    limit,
  }
}

/** Одна порция каталога или поиска (до фильтров цены/наличия) */
export async function fetchCatalogPage(
  query: CatalogQuery
): Promise<CatalogPageResult> {
  if (isSearchQuery(query.q)) {
    return searchProductsPage(query)
  }
  return listProductsPage(query)
}
