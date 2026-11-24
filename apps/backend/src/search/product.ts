import {
  defineSearchIndex,
  graphConsume,
  graphSeed,
  search,
} from "@medusajs/framework/utils"

/**
 * Индекс витрины: название, код/SKU, артикул МС, handle, описание.
 * article/sku вынесены в плоские searchable-поля — metadata.q их не видит.
 */
const source = {
  fields: [
    "id",
    "title",
    "description",
    "handle",
    "thumbnail",
    "status",
    "metadata",
    "variants.sku",
    "categories.id",
  ],
  transform: (
    products: Array<{
      id: string
      title?: string | null
      description?: string | null
      handle?: string | null
      thumbnail?: string | null
      status?: string | null
      metadata?: Record<string, unknown> | null
      variants?: Array<{ sku?: string | null } | null> | null
      categories?: Array<{ id?: string | null } | null> | null
    }>
  ) =>
    products.map((product) => {
      const article = String(product.metadata?.moysklad_article || "").trim()
      const sku = (product.variants || [])
        .map((variant) => String(variant?.sku || "").trim())
        .filter(Boolean)
        .join(" ")
      return {
        id: product.id,
        title: product.title || "",
        description: product.description || "",
        handle: product.handle || "",
        thumbnail: product.thumbnail || "",
        status: product.status || "draft",
        article,
        sku,
        category_ids: (product.categories || [])
          .map((category) => category?.id)
          .filter((id): id is string => Boolean(id)),
      }
    }),
}

export default defineSearchIndex({
  name: "product",
  entity: "product",
  fields: search.define({
    id: search.keyword().filterable().retrievable(),
    // Без sales_channel_ids: у нас товары не линкуются к каналу, иначе витрина всегда пустая
    status: search.keyword().filterable().retrievable(false),
    title: search.text().searchable({ weight: 3 }).retrievable(),
    article: search.text().searchable({ weight: 3 }).retrievable(),
    sku: search.text().searchable({ weight: 3 }).retrievable(),
    handle: search.text().searchable({ weight: 3 }).retrievable(),
    description: search.text().searchable({ weight: 1 }).retrievable(),
    thumbnail: search.keyword().retrievable(),
    category_ids: search.keyword().array().filterable().retrievable(),
  }),
  events: ["product.created", "product.updated", "product.deleted"],
  consume: graphConsume(source),
  seed: graphSeed(source),
})
