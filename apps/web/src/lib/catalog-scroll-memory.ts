const KEY = "amper-catalog-scroll"

export type CatalogScrollState = {
  path: string
  y: number
  loaded: number
  /** handle товара, в который ушли — надёжнее, чем один scrollY */
  anchor?: string
}

/** Нормализация пути каталога для сравнения */
export function normalizeCatalogPath(path: string): string {
  try {
    const url = new URL(path, "http://local.invalid")
    const params = new URLSearchParams(url.search)
    const keys = [...new Set([...params.keys()])].sort()
    const stable = new URLSearchParams()
    for (const key of keys) {
      for (const value of params.getAll(key)) stable.append(key, value)
    }
    const qs = stable.toString()
    return `${url.pathname}${qs ? `?${qs}` : ""}`
  } catch {
    return path
  }
}

export function saveCatalogScroll(state: CatalogScrollState) {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        ...state,
        path: normalizeCatalogPath(state.path),
      })
    )
  } catch {
    // sessionStorage может быть недоступен
  }
}

export function readCatalogScroll(): CatalogScrollState | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CatalogScrollState
    if (
      !parsed ||
      typeof parsed.path !== "string" ||
      typeof parsed.y !== "number" ||
      typeof parsed.loaded !== "number"
    ) {
      return null
    }
    return {
      ...parsed,
      path: normalizeCatalogPath(parsed.path),
      anchor:
        typeof parsed.anchor === "string" && parsed.anchor
          ? parsed.anchor
          : undefined,
    }
  } catch {
    return null
  }
}

export function peekCatalogScroll(path: string): CatalogScrollState | null {
  const state = readCatalogScroll()
  if (!state) return null
  if (normalizeCatalogPath(path) !== state.path) return null
  return state
}

export function clearCatalogScroll() {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}

export function catalogPathFromLocation(): string {
  if (typeof window === "undefined") return "/catalog"
  return normalizeCatalogPath(
    `${window.location.pathname}${window.location.search}`
  )
}

/** handle из /product/xxx */
export function productHandleFromHref(href: string): string | null {
  try {
    const path = href.startsWith("http")
      ? new URL(href).pathname
      : href.split("?")[0]
    const m = path.match(/^\/product\/([^/]+)\/?$/)
    return m ? decodeURIComponent(m[1]) : null
  } catch {
    return null
  }
}

export function needsCatalogRestore(state: CatalogScrollState | null): boolean {
  if (!state) return false
  return Boolean(state.anchor) || state.y >= 8
}
