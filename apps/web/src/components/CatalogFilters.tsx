"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { CatalogSelect } from "@/components/CatalogSelect"
import { Icon } from "@/components/icons"

const PRICE_OPTIONS = [
  { value: "any", label: "Любая цена" },
  { value: "300", label: "300 ₽" },
  { value: "1000", label: "1 000 ₽" },
  { value: "2000", label: "2 000 ₽" },
  { value: "5000", label: "5 000 ₽" },
  { value: "15000", label: "15 000 ₽" },
]

const SORT_OPTIONS = [
  { value: "popular", label: "По умолчанию" },
  { value: "low", label: "Сначала дешевле" },
  { value: "high", label: "Сначала дороже" },
]

/** Фильтры: клик раскрывает панель прямо под кнопкой (десктоп и мобилка) */
export function CatalogFilters({
  count,
  total,
}: {
  count: number
  /** Всего по API до клиентских фильтров; если нет — только «Показано: N» */
  total?: number
}) {
  const countLabel =
    typeof total === "number" && total > count
      ? `Показано: ${count} из ${total}`
      : `Показано: ${count}`
  const router = useRouter()
  const sp = useSearchParams()
  const [panelOpen, setPanelOpen] = useState(false)

  const max = sp.get("max") || "any"
  const onlyInStock = sp.get("stock") === "in"
  const sort = sp.get("sort") || "popular"

  const activeCount = [
    max !== "any",
    onlyInStock,
    sort !== "popular",
  ].filter(Boolean).length
  const hasCustomFilters = activeCount > 0

  function buildUrl(patch: Record<string, string | null>) {
    const params = new URLSearchParams(sp.toString())
    Object.entries(patch).forEach(([k, v]) => {
      if (!v || v === "any" || v === "popular" || v === "all") params.delete(k)
      else params.set(k, v)
    })
    const qs = params.toString()
    return qs ? `/catalog?${qs}` : "/catalog"
  }

  function patch(next: Record<string, string | null>) {
    router.push(buildUrl(next), { scroll: false })
  }

  function reset() {
    const params = new URLSearchParams()
    const cat = sp.get("cat")
    const q = sp.get("q")
    if (cat) params.set("cat", cat)
    if (q) params.set("q", q)
    const qs = params.toString()
    router.push(qs ? `/catalog?${qs}` : "/catalog", { scroll: false })
  }

  const fields = (
    <>
      <CatalogSelect
        label="Цена до"
        ariaLabel="Цена до"
        value={max}
        options={PRICE_OPTIONS}
        onChange={(v) => patch({ max: v })}
      />

      <CatalogSelect
        label="Сортировка"
        ariaLabel="Сортировка товаров"
        value={sort}
        options={SORT_OPTIONS}
        onChange={(v) => patch({ sort: v })}
      />

      <div className="filters-field filters-field-stock">
        <span className="filters-field-caption">Только в наличии</span>
        <label className="filter-stock-check">
          <input
            type="checkbox"
            checked={onlyInStock}
            aria-label="Только в наличии"
            onChange={(e) =>
              patch({ stock: e.target.checked ? "in" : "all" })
            }
          />
        </label>
      </div>
    </>
  )

  const toggle = (
    <button
      type="button"
      className={`filters-toggle${panelOpen ? " is-active" : ""}${
        hasCustomFilters ? " has-filters" : ""
      }`}
      aria-expanded={panelOpen}
      aria-controls="catalog-filter-fields"
      onClick={() => setPanelOpen((v) => !v)}
    >
      <Icon name="filter" />
      Фильтры
      {hasCustomFilters ? <b>{activeCount}</b> : null}
    </button>
  )

  const resetBtn = hasCustomFilters ? (
    <button
      type="button"
      className="reset-filters reset-filters-inline"
      onClick={reset}
    >
      Сбросить
    </button>
  ) : null

  return (
    <>
      {/* Десктоп */}
      <div
        className={`filters-box filters-desktop${panelOpen ? " is-open" : ""}`}
      >
        <div className="filters-head">
          <div className="filters-head-actions">
            {toggle}
            {resetBtn}
          </div>
          <span>{countLabel}</span>
        </div>
        {panelOpen ? (
          <div className="filters-toolbar" id="catalog-filter-fields">
            {fields}
          </div>
        ) : null}
      </div>

      {/* Мобилка: панель сразу под кнопкой, не снизу экрана */}
      <div className={`filters-mobile-wrap${panelOpen ? " is-open" : ""}`}>
        <div className="catalog-toolbar filters-mobile-bar">
          {toggle}
          {resetBtn}
          <span className="filters-mobile-count">{countLabel}</span>
        </div>
        {panelOpen ? (
          <div
            className="filters-toolbar filters-mobile-panel"
            id="catalog-filter-fields-mobile"
          >
            {fields}
          </div>
        ) : null}
      </div>
    </>
  )
}
