"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react"
import { flushSync } from "react-dom"
import { CatalogFilters } from "@/components/CatalogFilters"
import { CatalogMobileCategories } from "@/components/CatalogMobileCategories"
import { CatalogScrollProgress } from "@/components/CatalogScrollProgress"
import { ProductCard } from "@/components/ProductCard"
import { ScrollToTopButton } from "@/components/ScrollToTopButton"
import {
  CATALOG_PAGE_SIZE,
  applyCatalogFilters,
  fetchCatalogPage,
  type CatalogQuery,
} from "@/lib/catalog-products"
import {
  catalogPathFromLocation,
  clearCatalogScroll,
  needsCatalogRestore,
  normalizeCatalogPath,
  peekCatalogScroll,
  productHandleFromHref,
  saveCatalogScroll,
  type CatalogScrollState,
} from "@/lib/catalog-scroll-memory"
import type { StoreCategory } from "@/lib/catalog-nav"
import type { StoreProduct } from "@/lib/medusa"

type Filters = { max?: string; sort?: string; stock?: string }

type Props = {
  initialProducts: StoreProduct[]
  initialTotal: number
  query: Omit<CatalogQuery, "offset" | "limit">
  categories: StoreCategory[]
  activeHandle?: string | null
  filterState: Filters
  catalogHomeHref: string
  shortQuery?: boolean
}

function mergeProducts(
  prev: StoreProduct[],
  next: StoreProduct[]
): StoreProduct[] {
  const seen = new Set(prev.map((product) => product.id))
  return [...prev, ...next.filter((product) => !seen.has(product.id))]
}

/** Высота липких фильтров + жёлтой полоски */
function catalogStickyOffset(): number {
  const sticky = [
    ...document.querySelectorAll<HTMLElement>(
      ".catalog-mobile-sticky, .filters-desktop"
    ),
  ].find((node) => {
    const style = getComputedStyle(node)
    return (
      style.display !== "none" &&
      style.display !== "contents" &&
      node.getBoundingClientRect().height > 0
    )
  })
  const progress = document.querySelector<HTMLElement>(".catalog-scroll-progress")
  const stickyH = sticky ? sticky.getBoundingClientRect().height : 0
  const progressH = progress ? progress.offsetHeight : 0
  return Math.round(stickyH + progressH + 12)
}

function findAnchorNode(anchor: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-product-handle="${CSS.escape(anchor)}"]`
  )
}

function applyCatalogPosition(saved: CatalogScrollState): boolean {
  const root = document.documentElement
  const previousBehavior = root.style.scrollBehavior
  root.style.scrollBehavior = "auto"
  try {
    if (saved.anchor) {
      const node = findAnchorNode(saved.anchor)
      if (node) {
        const top =
          node.getBoundingClientRect().top + window.scrollY - catalogStickyOffset()
        window.scrollTo(0, Math.max(0, top))
        return true
      }
    }
    if (saved.y >= 8) {
      window.scrollTo(0, saved.y)
      return true
    }
    return false
  } finally {
    root.style.scrollBehavior = previousBehavior
  }
}

async function waitForAnchor(
  anchor: string | undefined,
  attempts = 120
): Promise<HTMLElement | null> {
  if (!anchor) return null
  for (let i = 0; i < attempts; i++) {
    const node = findAnchorNode(anchor)
    if (node) return node
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  return null
}

/**
 * Сетка каталога: SSR + infinite scroll.
 * Возврат из карточки — к тому же товару (якорь).
 */
export function CatalogResults({
  initialProducts,
  initialTotal,
  query,
  categories,
  activeHandle,
  filterState,
  catalogHomeHref,
  shortQuery,
}: Props) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const pagePath = normalizeCatalogPath(
    `${pathname}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`
  )

  const pendingRestoreRef = useRef<CatalogScrollState | null>(
    shortQuery ? null : peekCatalogScroll(pagePath)
  )
  const allowPersistRef = useRef(!needsCatalogRestore(pendingRestoreRef.current))
  /** Поколение restore — чтобы Strict Mode / повторный effect не «глушил» восстановление */
  const restoreGenRef = useRef(0)

  const [products, setProducts] = useState(initialProducts)
  const [total, setTotal] = useState(initialTotal)
  const [offset, setOffset] = useState(CATALOG_PAGE_SIZE)
  const [loading, setLoading] = useState(false)
  const [exhausted, setExhausted] = useState(
    initialProducts.length >= initialTotal ||
      initialProducts.length < CATALOG_PAGE_SIZE
  )
  const [error, setError] = useState("")
  /** Отмена догрузки при смене запроса: иначе старый поиск держит бэкенд */
  const abortRef = useRef<AbortController | null>(null)
  const [restoring, setRestoring] = useState(() =>
    needsCatalogRestore(pendingRestoreRef.current)
  )
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const feedRef = useRef<HTMLDivElement | null>(null)
  const loadingRef = useRef(false)
  const productsRef = useRef(products)
  const totalRef = useRef(total)
  const queryKey = JSON.stringify({ query, filterState })

  useEffect(() => {
    productsRef.current = products
  }, [products])

  useEffect(() => {
    totalRef.current = total
  }, [total])

  useLayoutEffect(() => {
    if (!needsCatalogRestore(pendingRestoreRef.current)) {
      document.documentElement.classList.remove("catalog-return-pending")
    }
  }, [pagePath])

  // Сброс только при смене фильтров/пути — НЕ на каждый новый массив initialProducts
  // (иначе после restore RSC «дожимает» первую порцию и сносит позицию к фильтрам).
  useEffect(() => {
    const pending = shortQuery ? null : peekCatalogScroll(pagePath)
    const needRestore = needsCatalogRestore(pending)

    // Если ждём возврат к якорю — не затираем уже подгруженный список первой порцией SSR
    if (needRestore && productsRef.current.length > initialProducts.length) {
      pendingRestoreRef.current = pending
      allowPersistRef.current = false
      setRestoring(true)
      return
    }

    setProducts(initialProducts)
    setTotal(initialTotal)
    setOffset(CATALOG_PAGE_SIZE)
    setExhausted(
      initialProducts.length >= initialTotal ||
        initialProducts.length < CATALOG_PAGE_SIZE
    )
    setError("")
    // Прошлая догрузка относится к прежнему запросу — отменяем
    abortRef.current?.abort()
    abortRef.current = null
    loadingRef.current = false
    pendingRestoreRef.current = pending
    setRestoring(needRestore)
    allowPersistRef.current = !needRestore
    // eslint-disable-next-line react-hooks/exhaustive-deps -- намеренно без initialProducts
  }, [queryKey, pagePath, shortQuery, initialTotal])

  const persistScroll = useCallback(() => {
    if (!allowPersistRef.current || shortQuery || productsRef.current.length === 0) {
      return
    }
    const prev = peekCatalogScroll(catalogPathFromLocation())
    // Не сохраняем «почти ноль» без якоря — это как раз залипание на фильтрах
    if (window.scrollY < 8 && !prev?.anchor) return
    saveCatalogScroll({
      path: catalogPathFromLocation(),
      y: window.scrollY,
      loaded: productsRef.current.length,
      anchor: prev?.anchor,
    })
  }, [shortQuery])

  useEffect(() => {
    if (shortQuery) return
    let ticking = false
    function onScroll() {
      if (ticking) return
      ticking = true
      requestAnimationFrame(() => {
        persistScroll()
        ticking = false
      })
    }
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [persistScroll, shortQuery])

  const loadMore = useCallback(async () => {
    if (loadingRef.current || exhausted || restoring) return
    loadingRef.current = true
    setLoading(true)
    setError("")
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    try {
      const page = await fetchCatalogPage({
        ...query,
        offset,
        limit: CATALOG_PAGE_SIZE,
        signal: controller.signal,
      })
      const filtered = applyCatalogFilters(page.products, {
        max: query.max,
        stock: query.stock,
        sort: query.sort,
      })
      setTotal(page.total)
      setProducts((prev) => mergeProducts(prev, filtered))
      const nextOffset = offset + CATALOG_PAGE_SIZE
      setOffset(nextOffset)
      if (
        page.products.length < CATALOG_PAGE_SIZE ||
        nextOffset >= page.total
      ) {
        setExhausted(true)
      }
    } catch (e) {
      // Отмена при смене фильтров/запроса — не ошибка для пользователя
      if (!controller.signal.aborted) {
        setError((e as Error).message || "Не удалось подгрузить товары")
      }
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [exhausted, offset, query, restoring])

  useEffect(() => {
    const saved = pendingRestoreRef.current
    if (!needsCatalogRestore(saved)) {
      allowPersistRef.current = true
      setRestoring(false)
      return
    }

    const gen = ++restoreGenRef.current
    let cancelled = false

    function isStale() {
      return cancelled || restoreGenRef.current !== gen
    }

    function finishRestore(ok: boolean) {
      if (isStale()) return
      // Память чистим только после удачного якоря; иначе оставим на повторный заход
      if (ok) {
        clearCatalogScroll()
        pendingRestoreRef.current = null
      }
      allowPersistRef.current = true
      setRestoring(false)
      setLoading(false)
      document.documentElement.classList.remove("catalog-return-pending")
    }

    async function restore() {
      setRestoring(true)
      setLoading(true)
      try {
        let list = productsRef.current
        let nextOffset = list.length
        let pageTotal = Math.max(totalRef.current, list.length)
        let guard = 0

        while (
          !isStale() &&
          list.length < saved!.loaded &&
          list.length < pageTotal &&
          guard < 80
        ) {
          guard += 1
          const page = await fetchCatalogPage({
            ...query,
            offset: nextOffset,
            limit: CATALOG_PAGE_SIZE,
          })
          const filtered = applyCatalogFilters(page.products, {
            max: query.max,
            stock: query.stock,
            sort: query.sort,
          })
          pageTotal = page.total
          list = mergeProducts(list, filtered)
          nextOffset += CATALOG_PAGE_SIZE
          if (page.products.length < CATALOG_PAGE_SIZE) break
        }

        if (isStale()) return

        flushSync(() => {
          setProducts(list)
          setTotal(pageTotal)
          setOffset(Math.max(nextOffset, CATALOG_PAGE_SIZE))
          setExhausted(list.length >= pageTotal || nextOffset >= pageTotal)
        })

        const node = await waitForAnchor(saved!.anchor)
        if (isStale()) return

        applyCatalogPosition(saved!)
        // Один короткий повтор после раскладки. Дальше скролл полностью принадлежит пользователю.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
        if (isStale()) return
        applyCatalogPosition(saved!)

        const landed = saved!.anchor
          ? Boolean(node && findAnchorNode(saved!.anchor))
          : saved!.y >= 8
        finishRestore(landed)
      } catch (e) {
        if (!isStale()) {
          setError((e as Error).message || "Не удалось восстановить позицию")
          finishRestore(false)
        }
      }
    }

    void restore()
    return () => {
      cancelled = true
      // Не clearCatalogScroll и не allowPersist — следующий effect (Strict Mode) продолжит
    }
  }, [pagePath, queryKey, query, shortQuery])

  useEffect(() => {
    const node = sentinelRef.current
    if (!node || exhausted || restoring) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadMore()
      },
      { root: null, rootMargin: "480px 0px", threshold: 0 }
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [exhausted, loadMore, products.length, restoring])

  function onFeedClick(e: MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement | null
    const link = target?.closest?.('a[href^="/product/"]') as HTMLAnchorElement | null
    if (!link) return
    if (
      e.button === 0 &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      // Класс остаётся на html во время карточки товара и скрывает первый
      // неправильный кадр каталога при возврате.
      document.documentElement.classList.add("catalog-return-pending")
    }
    allowPersistRef.current = true
    const handle =
      productHandleFromHref(link.getAttribute("href") || "") ||
      target?.closest?.("[data-product-handle]")?.getAttribute("data-product-handle") ||
      undefined
    saveCatalogScroll({
      path: catalogPathFromLocation(),
      y: window.scrollY,
      loaded: productsRef.current.length,
      anchor: handle || undefined,
    })
  }

  return (
    <>
      <ScrollToTopButton />

      {!shortQuery && products.length > 0 ? (
        <CatalogScrollProgress
          loaded={products.length}
          total={Math.max(total, products.length)}
          feedRef={feedRef}
        />
      ) : null}

      <div className="catalog-mobile-sticky">
        <CatalogMobileCategories
          categories={categories}
          activeHandle={activeHandle}
          filters={filterState}
        />
        <Suspense fallback={null}>
          <CatalogFilters count={products.length} total={total} />
        </Suspense>
      </div>

      {shortQuery ? (
        <div className="blank-state">
          <h2>Уточните запрос</h2>
          <p>Введите минимум 2 символа — название, артикул или код товара.</p>
        </div>
      ) : products.length ? (
        <div
          className="catalog-feed"
          ref={feedRef}
          onClickCapture={onFeedClick}
        >
          <div className="product-grid catalog-products">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
          <div
            ref={sentinelRef}
            className="catalog-feed-sentinel"
            aria-hidden="true"
          />
          <div className="catalog-feed-status" aria-live="polite">
            {loading || restoring ? (
              <span>
                {restoring
                  ? "Возвращаем к месту просмотра…"
                  : "Загружаем ещё…"}
              </span>
            ) : null}
            {error ? <span className="catalog-feed-error">{error}</span> : null}
            {!loading && !restoring && !error && exhausted ? (
              <span className="catalog-feed-end">Все товары загружены</span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="blank-state">
          <h2>Ничего не найдено</h2>
          <p>Попробуйте другую категорию или сбросьте фильтры.</p>
          <Link className="btn btn-primary" href={catalogHomeHref}>
            Все товары
          </Link>
        </div>
      )}
    </>
  )
}
