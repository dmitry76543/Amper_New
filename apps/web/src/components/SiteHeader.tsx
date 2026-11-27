"use client"

import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { FormEvent, Suspense, useEffect, useRef, useState } from "react"
import { useCart } from "@/components/CartProvider"
import { useCustomer } from "@/components/CustomerProvider"
import { Icon } from "@/components/icons"
import { Logo } from "@/components/Logo"
import { categoryShortName, type StoreCategory } from "@/lib/catalog-nav"
import { listStoreCategories } from "@/lib/medusa"

/**
 * Пауза перед live-поиском. Раньше было 520 мс: при медленном бэкенде
 * пользователь успевал набрать 5–6 символов, и пять запросов по 10 с
 * наслаивались друг на друга. Отдельно от этого — Enter и кнопка «Найти»
 * срабатывают сразу.
 */
const LIVE_SEARCH_DEBOUNCE_MS = 800

function accountLabel(customer: {
  first_name?: string | null
  email: string
} | null): string {
  if (!customer) return "Кабинет"
  const name = String(customer.first_name || "").trim()
  if (name) return name
  const email = customer.email || ""
  const at = email.indexOf("@")
  return at > 0 ? email.slice(0, at) : email || "Кабинет"
}

function SiteHeaderSearch() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const urlQ = searchParams.get("q") || ""
  const [q, setQ] = useState(urlQ)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPushedRef = useRef(urlQ)
  /** Пока печатаем — не затираем поле значением из URL после replace */
  const focusedRef = useRef(false)

  useEffect(() => {
    if (focusedRef.current) return
    setQ(urlQ)
    lastPushedRef.current = urlQ
  }, [urlQ])

  function goSearch(raw: string, replace: boolean) {
    const query = raw.trim()
    const href = query
      ? `/search?q=${encodeURIComponent(query)}`
      : "/catalog"
    const currentQ =
      pathname === "/catalog" || pathname === "/search"
        ? (searchParams.get("q") || "").trim()
        : lastPushedRef.current
    if (query === currentQ && (query || pathname === "/catalog")) return
    lastPushedRef.current = query
    if (replace) router.replace(href, { scroll: false })
    else router.push(href)
  }

  function onSearch(e: FormEvent) {
    e.preventDefault()
    if (debounceRef.current) clearTimeout(debounceRef.current)
    goSearch(q, false)
  }

  function onChange(value: string) {
    setQ(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      // В поле уже может быть длиннее — ищем по актуальному состоянию
      goSearch(value, true)
    }, LIVE_SEARCH_DEBOUNCE_MS)
  }

  function clearSearch() {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setQ("")
    goSearch("", true)
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const hasQuery = q.trim().length > 0

  return (
    <form
      className={`global-search${hasQuery ? " has-query" : ""}`}
      onSubmit={onSearch}
      role="search"
    >
      <input
        name="q"
        value={q}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => {
          focusedRef.current = true
        }}
        onBlur={() => {
          focusedRef.current = false
        }}
        placeholder="Поиск товара или артикула"
        aria-label="Поиск по товарам"
        autoComplete="off"
      />
      {hasQuery ? (
        <button
          type="button"
          className="global-search-clear"
          aria-label="Очистить поиск"
          title="Очистить"
          onClick={clearSearch}
        >
          <Icon name="x" />
        </button>
      ) : null}
      <button type="submit" aria-label="Найти">
        <Icon name="search" />
        <span>Найти</span>
      </button>
    </form>
  )
}

export function SiteHeader() {
  const { items } = useCart()
  const { customer } = useCustomer()
  const cartCount = items.reduce((sum, i) => sum + i.quantity, 0)
  const [navOpen, setNavOpen] = useState(false)
  const [categories, setCategories] = useState<StoreCategory[]>([])
  const cabinetLabel = accountLabel(customer)

  useEffect(() => {
    let cancelled = false
    listStoreCategories(true)
      .then((list) => {
        if (cancelled) return
        setCategories(list)
      })
      .catch(() => {
        if (!cancelled) setCategories([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <header className="site-header">
      <div className="header-main frame">
        <Logo />

        <Link href="/catalog" className="head-cat">
          <Icon name="grid" />
          <span>Каталог</span>
        </Link>

        <Suspense fallback={<form className="global-search" role="search"><input placeholder="Поиск товара или артикула" aria-label="Поиск по товарам" disabled /><button type="submit" disabled aria-label="Найти"><Icon name="search" /><span>Найти</span></button></form>}>
          <SiteHeaderSearch />
        </Suspense>

        <div className="header-icons">
          <Link
            href="/account"
            className={`head-icon account-trigger${customer ? " is-logged-in" : ""}`}
            aria-label={
              customer
                ? `Кабинет: вы вошли как ${cabinetLabel}`
                : "Открыть личный кабинет"
            }
            title={customer ? `Вы вошли · ${customer.email}` : "Личный кабинет"}
          >
            <Icon name="user" />
            <span>{cabinetLabel}</span>
            {customer ? <i className="account-online-dot" aria-hidden /> : null}
          </Link>
          <Link
            href="/favorites"
            className="head-icon fav-trigger"
            aria-label="Избранное"
          >
            <Icon name="heart" />
            <span>Избранное</span>
          </Link>
          <Link
            href="/cart"
            className="head-icon cart-trigger"
            aria-label="Открыть корзину"
          >
            <Icon name="bag" />
            <span>Корзина</span>
            {cartCount > 0 ? <b className="count">{cartCount}</b> : null}
          </Link>
          <button
            type="button"
            className="head-icon mobile-menu"
            aria-label="Открыть главное меню"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((v) => !v)}
          >
            <Icon name={navOpen ? "x" : "menu"} />
            <span>Меню</span>
          </button>
        </div>
      </div>

      <nav
        className={`main-nav ${navOpen ? "is-open" : ""}`}
        aria-label="Основная навигация"
      >
        <div className="frame nav-wrap">
          {/* Много динамических категорий — скролл внутри, без раздувания страницы */}
          <div className="nav-cats">
            {categories.map((c) => (
              <Link
                key={c.id}
                href={`/catalog?cat=${encodeURIComponent(c.handle)}`}
                onClick={() => setNavOpen(false)}
                title={c.name}
              >
                {categoryShortName(c.name)}
              </Link>
            ))}
          </div>
          <span className="nav-spacer" />
          <div className="nav-actions">
            <Link
              className="nav-action"
              href="/by-list"
              onClick={() => setNavOpen(false)}
            >
              По списку электрика
            </Link>
            <Link
              className="nav-action"
              href="/pro"
              onClick={() => setNavOpen(false)}
            >
              Профессионалам
            </Link>
            <Link
              className={`nav-action${customer ? " is-logged-in" : ""}`}
              href="/account"
              onClick={() => setNavOpen(false)}
            >
              {customer ? `Кабинет · ${cabinetLabel}` : "Кабинет"}
            </Link>
          </div>
        </div>
      </nav>
    </header>
  )
}
