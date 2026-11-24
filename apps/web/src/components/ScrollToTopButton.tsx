"use client"

import { useEffect, useState } from "react"
import { createPortal } from "react-dom"

type Props = {
  /** Показывать после этой высоты прокрутки */
  threshold?: number
}

/**
 * Кружок со стрелкой вверх — в каталоге, после прокрутки вниз.
 */
export function ScrollToTopButton({ threshold = 480 }: Props) {
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    function onScroll() {
      setVisible(window.scrollY > threshold)
    }
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [threshold])

  if (!mounted) return null

  return createPortal(
    <button
      type="button"
      className={`scroll-to-top${visible ? " is-visible" : ""}`}
      aria-label="Наверх"
      title="Наверх"
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M12 19V5" />
        <path d="M5 12l7-7 7 7" />
      </svg>
    </button>,
    document.body
  )
}
