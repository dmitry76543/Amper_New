/** Опции модуля МойСклад из medusa-config / .env */
export type MoySkladModuleOptions = {
  apiUrl: string
  apiToken?: string
  organizationId?: string
  storeId?: string
  priceTypeId?: string
  webhookSecret?: string
}

/** Картинка товара в МойСклад */
export type MoySkladProductImage = {
  id?: string
  title?: string
  filename?: string
  size?: number
  updated?: string
  meta?: {
    href?: string
    downloadHref?: string
    type?: string
  }
  miniature?: { href?: string }
  tiny?: { href?: string }
}

/** Товар из JSON API 1.2 МойСклад */
export type MoySkladFolderRef = { id?: string; meta?: { href?: string } }
export type MoySkladProductFolder = {
  id: string
  name: string
  pathName?: string
  archived?: boolean
  productFolder?: MoySkladFolderRef
}

export type MoySkladProduct = {
  id: string
  name: string
  description?: string
  article?: string
  code?: string
  pathName?: string
  archived?: boolean
  productFolder?: MoySkladFolderRef
  /** Момент последнего изменения в МойСклад (для умного синка) */
  updated?: string
  /** В списке приходит только meta.size; сами файлы — отдельным запросом */
  images?: { meta?: { size?: number; href?: string } }
  salePrices?: Array<{
    value: number
    priceType?: { meta?: { href?: string }; id?: string; name?: string }
  }>
  uom?: { meta?: { href?: string }; name?: string }
  meta?: { href?: string; type?: string }
  attributes?: Array<{ name?: string; value?: string | number | boolean }>
}

export type MoySkladStockRow = {
  meta?: { href?: string }
  stock: number
  freeStock?: number
  reserve?: number
  inTransit?: number
  quantity?: number
  name?: string
  article?: string
  code?: string
  /** ID ассортимента из href */
  assortmentId?: string
}

export type MoySkladOrganization = {
  id: string
  name: string
}

export type MoySkladStore = {
  id: string
  name: string
}

export type MoySkladPriceType = {
  id: string
  name: string
}
