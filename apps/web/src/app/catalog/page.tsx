import Link from "next/link"
import { Suspense } from "react"
import { Breadcrumbs } from "@/components/Breadcrumbs"
import { CatalogCategoryNav } from "@/components/CatalogCategoryNav"
import { CatalogResults } from "@/components/CatalogResults"
import { Icon } from "@/components/icons"
import { PageIntro } from "@/components/PageIntro"
import { categoryAncestors } from "@/lib/catalog-nav"
import {
  CATALOG_PAGE_SIZE,
  applyCatalogFilters,
  fetchCatalogPage,
  isSearchQuery,
} from "@/lib/catalog-products"
import { listStoreCategories } from "@/lib/medusa"

/** Ссылка на категорию с сохранением фильтров (наличие, цена, сортировка) */
function catalogHref(
  filters: { max?: string; sort?: string; stock?: string; q?: string },
  catHandle?: string | null
): string {
  const params = new URLSearchParams()
  if (catHandle) params.set("cat", catHandle)
  if (filters.q) params.set("q", filters.q)
  if (filters.max && filters.max !== "any") params.set("max", filters.max)
  if (filters.sort && filters.sort !== "popular") params.set("sort", filters.sort)
  if (filters.stock === "in") params.set("stock", "in")
  const qs = params.toString()
  return qs ? `/catalog?${qs}` : "/catalog"
}

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    cat?: string
    max?: string
    sort?: string
    stock?: string
  }>
}) {
  const sp = await searchParams
  const rawQ = (sp.q || "").trim()
  const shortQuery = Boolean(rawQ) && !isSearchQuery(rawQ)
  const filterState = { max: sp.max, sort: sp.sort, stock: sp.stock }
  let error = ""
  let categories: Awaited<ReturnType<typeof listStoreCategories>> = []

  try {
    categories = await listStoreCategories()
  } catch {
    categories = []
  }

  const activeCat =
    categories.find((c) => c.handle === sp.cat) ||
    categories.find((c) => c.id === sp.cat)
  const unavailableCategory = Boolean(sp.cat && !activeCat)
  const ancestors = categoryAncestors(categories, activeCat?.id)
  const childCategories = categories.filter(
    (category) =>
      (category.parent_category_id || null) === (activeCat?.id || null)
  )

  let initialProducts: Awaited<
    ReturnType<typeof fetchCatalogPage>
  >["products"] = []
  let initialTotal = 0

  try {
    if (unavailableCategory) {
      throw new Error("Этот раздел недоступен. Выберите другую категорию.")
    }
    if (!shortQuery) {
      const page = await fetchCatalogPage({
        q: rawQ || undefined,
        categoryId: activeCat?.id,
        offset: 0,
        limit: CATALOG_PAGE_SIZE,
      })
      initialTotal = page.total
      initialProducts = applyCatalogFilters(page.products, filterState)
    }
  } catch (e) {
    error = (e as Error).message
  }

  const title = rawQ
    ? "Результаты поиска"
    : activeCat?.name ||
      (unavailableCategory ? "Раздел недоступен" : "Каталог товаров")
  const lead = rawQ
    ? `По запросу «${rawQ}»`
    : "Выберите категорию и уточните параметры."

  return (
    <div className="frame interior catalog-page">
      <Breadcrumbs
        items={[
          {
            label: "Каталог",
            href:
              activeCat || rawQ ? catalogHref(filterState) : undefined,
          },
          ...ancestors.map((category, index) => ({
            label: category.name,
            href:
              index < ancestors.length - 1
                ? catalogHref(filterState, category.handle)
                : undefined,
          })),
          ...(rawQ && !activeCat ? [{ label: "Поиск" }] : []),
        ]}
      />
      <PageIntro eyebrow="Каталог" title={title} lead={lead} />

      <div className="catalog-layout">
        <aside className="catalog-aside">
          <h2 className="catalog-cats-title">
            <span>Категории</span>
          </h2>
          <CatalogCategoryNav
            variant="aside"
            categories={categories}
            activeHandle={activeCat?.handle || sp.cat || null}
            filters={filterState}
          />
          <div className="aside-hint">
            <Icon name="info" /> Наличие и стоимость уточняются при оформлении.
          </div>
        </aside>

        <div className="catalog-content">
          {childCategories.length > 0 && (
            <section
              className="catalog-subcategories"
              aria-label={
                activeCat ? "Подкатегории" : "Разделы каталога"
              }
            >
              <h2>{activeCat ? "Подкатегории" : "Разделы каталога"}</h2>
              <div className="catalog-subcategory-links">
                {childCategories.map((category) => (
                  <Link
                    key={category.id}
                    href={catalogHref(filterState, category.handle)}
                  >
                    {category.name}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {error ? (
            <div className="empty-state">
              Не удалось загрузить каталог: {error}
            </div>
          ) : (
            <Suspense fallback={<div className="empty-state">Загружаем каталог…</div>}>
              <CatalogResults
                initialProducts={initialProducts}
                initialTotal={initialTotal}
                query={{
                  q: rawQ || undefined,
                  categoryId: activeCat?.id,
                  max: sp.max,
                  sort: sp.sort,
                  stock: sp.stock,
                }}
                categories={categories}
                activeHandle={activeCat?.handle || sp.cat || null}
                filterState={filterState}
                catalogHomeHref={catalogHref(filterState)}
                shortQuery={shortQuery}
              />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  )
}
