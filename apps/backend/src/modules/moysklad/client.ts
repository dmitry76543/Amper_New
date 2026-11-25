import type {
  MoySkladModuleOptions,
  MoySkladProduct,
  MoySkladProductFolder,
  MoySkladProductImage,
  MoySkladStockRow,
} from "./types"

import { toMoySkladDateTime } from "./date-format"

type ListResponse<T> = {
  meta?: { size?: number; limit?: number; offset?: number; nextHref?: string }
  rows: T[]
}

/**
 * HTTP-клиент к JSON API 1.2 МойСклад.
 * Учитывает лимиты: пагинация, повтор при 429/5xx.
 */
export class MoySkladClient {
  private readonly baseUrl: string
  private readonly token: string

  constructor(options: MoySkladModuleOptions) {
    if (!options.apiToken) {
      throw new Error("MOYSKLAD_API_TOKEN не задан")
    }
    this.baseUrl = (options.apiUrl || "https://api.moysklad.ru/api/remap/1.2").replace(/\/$/, "")
    this.token = options.apiToken
  }

  /** Разрешена ли запись в МС (контрагенты, заказы и т.п.). Чтение всегда можно. */
  private writesAllowed(): boolean {
    return process.env.MOYSKLAD_ALLOW_WRITES === "true"
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    attempt = 1
  ): Promise<T> {
    const method = String(init.method || "GET").toUpperCase()
    // Барьер на время тестов: в рабочий МойСклад ничего не создаём/не меняем
    if (method !== "GET" && method !== "HEAD" && !this.writesAllowed()) {
      throw new Error(
        `МойСклад: запись запрещена (MOYSKLAD_ALLOW_WRITES≠true), ${method} ${path}`
      )
    }

    const url = path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? "" : "/"}${path}`
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json;charset=utf-8",
        "Content-Type": "application/json",
        ...(init.headers || {}),
      },
    })

    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const retryAfter = Number(res.headers.get("Retry-After") || 0)
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : attempt * 1000
      await new Promise((r) => setTimeout(r, waitMs))
      return this.request<T>(path, init, attempt + 1)
    }

    if (!res.ok) {
      const body = await res.text()
      throw new Error(`МойСклад API ${res.status}: ${body.slice(0, 500)}`)
    }

    if (res.status === 204) {
      return undefined as T
    }

    return (await res.json()) as T
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: "GET" })
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "POST", body: JSON.stringify(body) })
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PUT", body: JSON.stringify(body) })
  }

  /** Постраничная выгрузка всех строк списка */
  async listAll<T>(path: string, limit = 100): Promise<T[]> {
    const rows: T[] = []
    let offset = 0
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const sep = path.includes("?") ? "&" : "?"
      const page = await this.get<ListResponse<T>>(`${path}${sep}limit=${limit}&offset=${offset}`)
      rows.push(...(page.rows || []))
      const size = page.meta?.size ?? rows.length
      offset += limit
      if (offset >= size || !(page.rows || []).length) {
        break
      }
    }
    return rows
  }

  async listProducts(archived = false): Promise<MoySkladProduct[]> {
    const filter = archived ? "" : "filter=archived=false"
    // expand=uom — иначе приходит только href без name (шт/м/упак)
    return this.listAll<MoySkladProduct>(
      `/entity/product?${filter}&expand=uom`
    )
  }

  async listStockByStore(storeId: string): Promise<MoySkladStockRow[]> {
    const href = `${this.baseUrl}/entity/store/${storeId}`
    const encoded = encodeURIComponent(href)
    return this.listAll<MoySkladStockRow>(
      `/report/stock/bystore/current?filter=store=${encoded}&stockMode=all`
    )
  }

  /**
   * Краткий доступный остаток, изменившийся после указанного момента.
   * freeStock уже исключает резервы, но не добавляет ожидаемые поступления.
   */
  async listChangedFreeStock(
    storeId: string,
    changedSince?: string
  ): Promise<MoySkladStockRow[]> {
    const params = new URLSearchParams({
      stockType: "freeStock",
      filter: `storeId=${storeId}`,
    })
    if (changedSince) {
      params.set(
        "changedSince",
        new Date(changedSince)
          .toISOString()
          .replace("T", " ")
          .replace(/\.\d{3}Z$/, "")
      )
    } else {
      params.set("include", "zeroLines")
    }
    return this.get<MoySkladStockRow[]>(
      `/report/stock/all/current?${params.toString()}`
    )
  }

  /** The API excludes archived folders by default; explicitly read both sets. */
  async listProductFolders(): Promise<MoySkladProductFolder[]> {
    const active = await this.listAll<MoySkladProductFolder>("/entity/productfolder?filter=archived=false")
    const archived = await this.listAll<MoySkladProductFolder>("/entity/productfolder?filter=archived=true")
    return [...active, ...archived]
  }

  /** Альтернативный отчёт остатков (если bystore недоступен) */
  async listStockAll(): Promise<MoySkladStockRow[]> {
    return this.listAll<MoySkladStockRow>(`/report/stock/all?stockMode=all`)
  }

  async getOrganization(id: string) {
    return this.get<{ id: string; name: string }>(`/entity/organization/${id}`)
  }

  async listOrganizations() {
    return this.listAll<{ id: string; name: string }>(`/entity/organization`)
  }

  async listStores() {
    return this.listAll<{ id: string; name: string }>(`/entity/store`)
  }

  async listPriceTypes() {
    // В API 1.2 типы цен — entity/pricetype
    return this.listAll<{ id: string; name: string }>(`/entity/pricetype`)
  }

  async findCounterpartyByEmail(email: string) {
    const filter = encodeURIComponent(`email=${email}`)
    const data = await this.get<ListResponse<{ id: string; name: string; email?: string }>>(
      `/entity/counterparty?filter=${filter}&limit=1`
    )
    return data.rows?.[0]
  }

  async createCounterparty(payload: {
    name: string
    email?: string
    phone?: string
  }) {
    return this.post<{ id: string; name: string; email?: string; meta: { href: string } }>(
      `/entity/counterparty`,
      payload
    )
  }

  async createCustomerOrder(payload: Record<string, unknown>) {
    return this.post<{ id: string; name: string; meta: { href: string } }>(
      `/entity/customerorder`,
      payload
    )
  }

  /** Поиск заказа по постоянному ID Medusa — защита от повторного создания */
  async findCustomerOrderByExternalCode(externalCode: string) {
    const filter = encodeURIComponent(`externalCode=${externalCode}`)
    const data = await this.get<
      ListResponse<{ id: string; name: string; externalCode?: string }>
    >(`/entity/customerorder?filter=${filter}&limit=1`)
    return data.rows?.[0]
  }

  async getCustomerOrder(id: string) {
    return this.get<{
      id: string
      name: string
      state?: { name?: string; meta?: { href?: string } }
      shipped?: boolean
      meta: { href: string }
    }>(`/entity/customerorder/${id}`)
  }

  async listCustomerOrdersUpdatedSince(moment: Date) {
    const filter = encodeURIComponent(`updated>${toMoySkladDateTime(moment)}`)
    return this.listAll<{
      id: string
      name: string
      externalCode?: string
      state?: { name?: string }
      updated?: string
    }>(`/entity/customerorder?filter=${filter}`)
  }

  entityHref(type: string, id: string) {
    return `${this.baseUrl}/entity/${type}/${id}`
  }

  extractIdFromHref(href?: string): string | undefined {
    if (!href) return undefined
    // href иногда с ?expand=… — иначе id не совпадёт с moysklad_id
    const clean = href.split("?")[0].split("#")[0]
    const parts = clean.split("/").filter(Boolean)
    return parts[parts.length - 1]
  }

  /** Список картинок товара (обычно 0–несколько) */
  async listProductImages(productId: string): Promise<MoySkladProductImage[]> {
    const data = await this.get<ListResponse<MoySkladProductImage>>(
      `/entity/product/${productId}/images`
    )
    return data.rows || []
  }

  /**
   * Скачать бинарник по downloadHref МойСклад (нужен Bearer).
   * Возвращает буфер и предполагаемый mime по имени файла.
   */
  async downloadFile(
    downloadHref: string,
    filenameHint?: string
  ): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
    const url = downloadHref.startsWith("http")
      ? downloadHref
      : `${this.baseUrl}${downloadHref.startsWith("/") ? "" : "/"}${downloadHref}`

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "*/*",
      },
    })

    if ((res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500))
      return this.downloadFile(downloadHref, filenameHint)
    }

    if (!res.ok) {
      throw new Error(`МойСклад download ${res.status}`)
    }

    const ab = await res.arrayBuffer()
    const buffer = Buffer.from(ab)
    const filename =
      filenameHint ||
      res.headers.get("content-disposition")?.match(/filename="?([^";]+)"?/i)?.[1] ||
      `moysklad-${Date.now()}.bin`
    const headerMime = res.headers.get("content-type") || ""
    const mimeType = headerMime.includes("image/")
      ? headerMime.split(";")[0].trim()
      : guessMimeFromName(filename)

    return { buffer, mimeType, filename }
  }
}

function guessMimeFromName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".svg")) return "image/svg+xml"
  return "image/jpeg"
}
