import { MoySkladClient } from "./client"
import type { MoySkladModuleOptions, MoySkladProduct } from "./types"
import { MedusaService } from "@medusajs/framework/utils"
import MoyskladOrderOutbox from "./models/order-outbox"
import MoyskladSyncLock from "./models/sync-lock"

/**
 * Сервис модуля МойСклад: клиент API и вспомогательные маппинги.
 * Интеграционный клиент и постоянная очередь заказов.
 */
class MoySkladModuleService extends MedusaService({
  MoyskladOrderOutbox,
  MoyskladSyncLock,
}) {
  protected options_: MoySkladModuleOptions
  protected client_: MoySkladClient | null = null

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(container: Record<string, unknown>, options: MoySkladModuleOptions) {
    super(container)
    this.options_ = options || ({} as MoySkladModuleOptions)
  }

  getOptions() {
    return this.options_
  }

  getClient(): MoySkladClient {
    if (!this.client_) {
      this.client_ = new MoySkladClient(this.options_)
    }
    return this.client_
  }

  /** Проверка токена и доступности API */
  async ping(): Promise<{ ok: boolean; productSample?: string }> {
    const client = this.getClient()
    const products = await client.get<{ rows: MoySkladProduct[] }>(`/entity/product?limit=1`)
    return {
      ok: true,
      productSample: products.rows?.[0]?.name,
    }
  }

  /** Подтянуть ID организации/склада/типа цены, если не заданы в env */
  async resolveDefaults(): Promise<{
    organizationId: string
    storeId: string
    priceTypeId?: string
  }> {
    const client = this.getClient()
    let organizationId = this.options_.organizationId
    let storeId = this.options_.storeId
    let priceTypeId = this.options_.priceTypeId

    if (!organizationId) {
      const orgs = await client.listOrganizations()
      if (!orgs.length) throw new Error("В МойСклад нет организаций")
      organizationId = orgs[0].id
    }

    if (!storeId) {
      const stores = await client.listStores()
      if (!stores.length) throw new Error("В МойСклад нет складов")
      storeId = stores[0].id
    }

    if (!priceTypeId) {
      try {
        const types = await client.listPriceTypes()
        priceTypeId = types[0]?.id
      } catch {
        // тип цены может быть вложен в salePrices товара
      }
    }

    this.options_ = {
      ...this.options_,
      organizationId,
      storeId,
      priceTypeId,
    }

    return { organizationId, storeId, priceTypeId }
  }

  /** Единица измерения МойСклад: шт, м, упак… */
  pickUomName(product: MoySkladProduct): string {
    const raw = (product.uom?.name || "").trim()
    if (!raw) return "шт"
    // нормализуем частые варианты написания
    const lower = raw.toLowerCase().replace(/\.$/, "")
    if (lower === "шт" || lower === "штука" || lower === "штук") return "шт"
    if (lower === "м" || lower === "метр" || lower === "метра") return "м"
    if (lower === "п" || lower === "пог.м" || lower === "пог м") return "м"
    if (lower === "уп" || lower === "упак" || lower === "упаковка") return "упак"
    if (lower === "кг" || lower === "килограмм") return "кг"
    return raw
  }

  /** Цена в копейках из salePrices товара */
  pickSalePriceKopecks(product: MoySkladProduct): number {
    const prices = product.salePrices || []
    if (!prices.length) return 0

    const wanted = this.options_.priceTypeId
    if (wanted) {
      const match = prices.find((p) => {
        const href = p.priceType?.meta?.href || ""
        const id = p.priceType?.id || this.getClient().extractIdFromHref(href)
        return id === wanted
      })
      if (match) return Math.round(match.value)
    }

    return Math.round(prices[0].value || 0)
  }

  /**
   * Handle для Medusa.
   * В МойСклад часто несколько отдельных товаров с одним артикулом модели
   * (разный цвет), но разными кодами — поэтому приоритет: код, иначе артикул+код, иначе id.
   */
  toHandle(product: MoySkladProduct): string {
    const article = (product.article || "").trim()
    const code = (product.code || "").trim()
    let raw = product.id
    if (code && article && code.toLowerCase() !== article.toLowerCase()) {
      raw = `${article}-${code}`
    } else if (code) {
      raw = code
    } else if (article) {
      raw = article
    }
    // Только латиница/цифры в URL: кириллический handle ломает часть роутов/прокси
    return String(raw)
      .toLowerCase()
      .replace(/а/g, "a")
      .replace(/б/g, "b")
      .replace(/в/g, "v")
      .replace(/г/g, "g")
      .replace(/д/g, "d")
      .replace(/е/g, "e")
      .replace(/ё/g, "e")
      .replace(/ж/g, "zh")
      .replace(/з/g, "z")
      .replace(/и/g, "i")
      .replace(/й/g, "y")
      .replace(/к/g, "k")
      .replace(/л/g, "l")
      .replace(/м/g, "m")
      .replace(/н/g, "n")
      .replace(/о/g, "o")
      .replace(/п/g, "p")
      .replace(/р/g, "r")
      .replace(/с/g, "s")
      .replace(/т/g, "t")
      .replace(/у/g, "u")
      .replace(/ф/g, "f")
      .replace(/х/g, "h")
      .replace(/ц/g, "ts")
      .replace(/ч/g, "ch")
      .replace(/ш/g, "sh")
      .replace(/щ/g, "sch")
      .replace(/ъ/g, "")
      .replace(/ы/g, "y")
      .replace(/ь/g, "")
      .replace(/э/g, "e")
      .replace(/ю/g, "yu")
      .replace(/я/g, "ya")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120)
  }

  /** SKU: код МойСклад уникален чаще артикула */
  toSku(product: MoySkladProduct): string {
    return (product.code || product.article || product.id).trim()
  }
}

export default MoySkladModuleService
