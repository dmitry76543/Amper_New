"use client"

import { useEffect, useState, type RefObject } from "react"
import { createPortal } from "react-dom"

type Props = {
  /** Сколько карточек уже на экране (подгружено) */
  loaded: number
  /** Всего по текущей выборке / поиску */
  total: number
  /** Корень ленты товаров */
  feedRef: RefObject<HTMLElement | null>
}

/**
 * Верхняя жёлтая полоска: где мы в полном списке.
 * 100% = total. Рендер в body, чтобы не пряталась под шапкой/sticky.
 */
export function CatalogScrollProgress({ loaded, total, feedRef }: Props) {
  const [progress, setProgress] = useState(0)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  useEffect(() => {
    if (!total || !loaded) {
      setProgress(0)
      return
    }

    function update() {
      const feed = feedRef.current
      if (!feed || total <= 0) {
        setProgress(0)
        return
      }
      const rect = feed.getBoundingClientRect()
      const feedTop = window.scrollY + rect.top
      const feedHeight = Math.max(feed.offsetHeight, 1)
      const viewport = window.innerHeight
      // Доля пройденной ленты (0 вверху списка → 1 внизу уже подгруженного)
      const scrolledIntoFeed = window.scrollY + viewport * 0.35 - feedTop
      const withinFeed = Math.min(1, Math.max(0, scrolledIntoFeed / feedHeight))
      const loadedShare = Math.min(1, loaded / Math.max(total, 1))
      setProgress(Math.min(1, withinFeed * loadedShare))
    }

    update()
    const onScroll = () => update()
    window.addEventListener("scroll", onScroll, { passive: true })
    window.addEventListener("resize", onScroll)
    const ro = new ResizeObserver(onScroll)
    const feedEl = feedRef.current
    if (feedEl) ro.observe(feedEl)
    return () => {
      window.removeEventListener("scroll", onScroll)
      window.removeEventListener("resize", onScroll)
      ro.disconnect()
    }
  }, [feedRef, loaded, total])

  if (!mounted || total <= 0 || loaded <= 0) return null

  const pct = Math.round(progress * 1000) / 10

  return createPortal(
    <div
      className="catalog-scroll-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label="Прогресс по списку товаров"
    >
      <span className="catalog-scroll-progress-fill" style={{ width: `${pct}%` }} />
    </div>,
    document.body
  )
}
