import {
  createWorkflow,
  WorkflowResponse,
  createStep,
  StepResponse,
} from "@medusajs/framework/workflows-sdk"
import {
  createProductsWorkflow,
  updateProductsWorkflow,
  upsertVariantPricesWorkflow,
} from "@medusajs/medusa/core-flows"
import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import { MOYSKLAD_MODULE } from "../modules/moysklad"
import { rootFolderFromPath } from "../modules/moysklad/category-utils"
import { ensureMoyskladCategories } from "../modules/moysklad/ensure-categories"
import type MoySkladModuleService from "../modules/moysklad/service"
import type { MoySkladProduct } from "../modules/moysklad/types"
import type { MedusaContainer } from "@medusajs/framework/types"
import { syncAllMoyskladStock } from "../modules/moysklad/stock-sync"

/** Medusa 2 хранит цену в основных единицах валюты (рубли, не копейки) */
function rubFromKopecks(kopecks: number): number {
  return Math.max(0, Math.round(Number(kopecks) || 0) / 100)
}

type SyncResult = {
  created: number
  updated: number
  unchanged: number
  skipped: number
  imagesSynced: number
  stockUpdated: number
  stockUnchanged: number
  hidden: number
  errors: string[]
}

/** Максимум кадров галереи с одной карточки МойСклад */
const MAX_PRODUCT_IMAGES = 8

/**
 * Отпечаток карточки: если совпал с metadata.moysklad_sync_fp — апдейт не нужен.
 * updated + imgSize ловят смену фото без полного перекачивания всего каталога.
 */
function buildProductFp(
  ms: MoySkladProduct,
  amount: number,
  sku: string,
  uom: string
): string {
  return [
    ms.name,
    ms.description || "",
    ms.article || "",
    ms.code || "",
    ms.pathName || "",
    String(amount),
    sku,
    uom,
    ms.updated || "",
    String(ms.images?.meta?.size || 0),
  ].join("\n")
}

/**
 * Скачать фото товара из МойСклад и залить в File Module Medusa.
 * Возвращает список URL (первый = thumbnail) или null.
 */
async function uploadMoySkladImages(params: {
  client: ReturnType<MoySkladModuleService["getClient"]>
  fileModule: {
    createFiles: (
      data: Array<{ filename: string; mimeType: string; content: string }>
    ) => Promise<Array<{ url: string; id?: string }>>
  }
  productId: string
}): Promise<{ urls: string[]; sourceIds: string[]; fingerprint: string } | null> {
  const images = await params.client.listProductImages(params.productId)
  if (!images.length) return null

  const urls: string[] = []
  const sourceIds: string[] = []
  const fpParts: string[] = []

  for (const img of images.slice(0, MAX_PRODUCT_IMAGES)) {
    const downloadHref = img.meta?.downloadHref
    if (!downloadHref) continue

    fpParts.push(`${img.id || ""}:${img.updated || ""}`)

    const { buffer, mimeType, filename } = await params.client.downloadFile(
      downloadHref,
      img.filename || `${params.productId}-${sourceIds.length}.jpg`
    )

    const [uploaded] = await params.fileModule.createFiles([
      {
        filename: `ms-${params.productId}-${filename}`.replace(/[^\w.\-]+/g, "_"),
        mimeType,
        content: buffer.toString("base64"),
      },
    ])

    if (!uploaded?.url) continue
    urls.push(uploaded.url)
    sourceIds.push(img.id || downloadHref)
  }

  if (!urls.length) return null
  return { urls, sourceIds, fingerprint: fpParts.join("|") }
}

/**
 * Прописать/обновить цену варианта в Pricing Module (нужно для корзины).
 * updateProductVariantsWorkflow только правит уже существующий price set —
 * для товаров без цены создаём через upsertVariantPricesWorkflow.
 */
async function upsertVariantRubPrice(
  container: MedusaContainer,
  variantId: string,
  productId: string,
  kopecks: number,
  extraMeta: Record<string, string>
) {
  const rub = rubFromKopecks(kopecks)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const linkService = link.getLinkModule(
    Modules.PRODUCT,
    "variant_id",
    Modules.PRICING,
    "price_set_id"
  )
  if (!linkService) throw new Error("Product-pricing link module is not available")
  const existing = (await linkService.list(
    { variant_id: [variantId] },
    { select: ["variant_id", "price_set_id"] }
  )) as Array<{ variant_id: string }>

  await upsertVariantPricesWorkflow(container).run({
    input: {
      variantPrices: [
        {
          variant_id: variantId,
          product_id: productId,
          prices: [{ amount: rub, currency_code: "rub" }],
        },
      ],
      // id в previous → update price set; иначе create + link
      previousVariantIds: existing.length ? [variantId] : [],
    },
  })

  const productModule = container.resolve(Modules.PRODUCT)
  await productModule.updateProductVariants(variantId, {
    metadata: {
      ...extraMeta,
      moysklad_price_kopecks: String(kopecks),
      moysklad_medusa_priced: String(kopecks),
    },
  })
}

/**
 * Шаг: умный импорт товаров/цен/фото из МойСклад.
 * Без изменений title/description/цены/updated/числа фото — товар пропускаем.
 * Фото качаем при нехватке кадров или смене fingerprint (id:updated).
 * Цену в Medusa Pricing пишем обязательно (иначе Store cart: «do not have a price»).
 */
const syncProductsStep = createStep(
  "moysklad-sync-products",
  async (_input: void, { container }) => {
    const moysklad: MoySkladModuleService = container.resolve(MOYSKLAD_MODULE)
    const productModule = container.resolve(Modules.PRODUCT)
    const salesChannelModule = container.resolve(Modules.SALES_CHANNEL)
    const fulfillmentModule = container.resolve(Modules.FULFILLMENT)
    const fileModule = container.resolve(Modules.FILE)

    await moysklad.resolveDefaults()
    const client = moysklad.getClient()
    // Read complete source snapshots before changing visibility in Medusa.
    const sourceProducts = await client.listProducts(false)
    const folders = await client.listProductFolders()
    const { tree, categoryIdsForProduct } = await ensureMoyskladCategories(container, folders)
    const products = sourceProducts.filter((product) => tree.isVisible(product))

    const byMsId = new Map<
      string,
      Awaited<ReturnType<typeof productModule.listProducts>>[0]
    >()
    const pageSize = 500
    for (let skip = 0; ; skip += pageSize) {
      const page = await productModule.listProducts(
        {},
        { take: pageSize, skip, relations: ["variants", "images", "categories"] }
      )
      for (const p of page) {
        const msId = (p.metadata as Record<string, string> | null)?.moysklad_id
        if (msId) byMsId.set(msId, p)
      }
      if (page.length < pageSize) break
    }

    const channels = await salesChannelModule.listSalesChannels({}, { take: 1 })
    const defaultChannelId = channels[0]?.id

    // Без shipping profile Store не отдаёт опции Самовывоз/Доставка для корзины
    const shippingProfiles = await fulfillmentModule.listShippingProfiles(
      {},
      { take: 20 }
    )
    const defaultShippingProfileId =
      shippingProfiles.find(
        (p) => p.type === "default" || /default/i.test(p.name)
      )?.id || shippingProfiles[0]?.id

    let created = 0
    let updated = 0
    let unchanged = 0
    let skipped = 0
    let imagesSynced = 0
    let hidden = 0
    const errors: string[] = []

    const visibleSourceIds = new Set(products.map((product) => product.id))
    for (const [msId, product] of byMsId) {
      if (visibleSourceIds.has(msId)) continue
      if (product.status === "draft" && product.metadata?.moysklad_hidden === "1") continue
      // Archived/deleted products and products under archived folders must stop being purchasable.
      // Do not delete records: carts and historical orders can still reference them.
      await productModule.updateProducts(product.id, {
        status: "draft",
        metadata: { ...product.metadata, moysklad_hidden: "1" },
      })
      hidden += 1
    }

    for (const ms of products) {
      try {
        const handle = moysklad.toHandle(ms)
        const sku = moysklad.toSku(ms)
        const amount = moysklad.pickSalePriceKopecks(ms)
        const uom = moysklad.pickUomName(ms)
        const rootFolder = rootFolderFromPath(ms.pathName)
        const categoryIds = categoryIdsForProduct(ms)
        const found = byMsId.get(ms.id)
        let productId = found?.id
        const msImageCount = ms.images?.meta?.size || 0
        const syncFp = buildProductFp(ms, amount, sku, uom)

        if (found) {
          const wasHidden = found.metadata?.moysklad_hidden === "1"
          const meta = { ...found.metadata, moysklad_hidden: "" } as Record<string, string>
          const medusaImageCount = Math.max(
            found.images?.length || 0,
            found.thumbnail ? 1 : 0
          )
          const syncedCount = Number(meta.moysklad_images_count || 0)
          const wantImages = Math.min(msImageCount, MAX_PRODUCT_IMAGES)
          // В МС есть фото, а в Medusa меньше (или ещё не отмечали) — обязательно качаем
          const imagesIncomplete =
            msImageCount > 0 &&
            (medusaImageCount < wantImages ||
              syncedCount < wantImages ||
              (!medusaImageCount && !meta.moysklad_images_fp))

          const pricedOk =
            meta.moysklad_medusa_priced === String(amount) ||
            (found.variants?.[0]?.metadata as Record<string, string> | null)
              ?.moysklad_medusa_priced === String(amount)

          const currentCatIds = (
            (found as { categories?: Array<{ id: string }> }).categories || []
          ).map((c) => c.id)
          const categorizedOk = currentCatIds.length === categoryIds.length && categoryIds.every((id) => currentCatIds.includes(id))

          // Карточка не менялась, цена/категория на месте, фото ок — пропускаем
          if (
            meta.moysklad_sync_fp === syncFp &&
            !imagesIncomplete &&
            pricedOk &&
            categorizedOk &&
            !wasHidden
          ) {
            unchanged += 1
            continue
          }

          // Не хватает кадров; при смене отпечатка карточки — сверяем набор фото в МС
          let needsImage = imagesIncomplete
          if (
            !needsImage &&
            msImageCount > 0 &&
            meta.moysklad_sync_fp !== syncFp
          ) {
            const remote = await client.listProductImages(ms.id)
            const remoteFp = remote
              .slice(0, MAX_PRODUCT_IMAGES)
              .map((i) => `${i.id || ""}:${i.updated || ""}`)
              .join("|")
            if (remoteFp && remoteFp !== (meta.moysklad_images_fp || "")) {
              needsImage = true
            }
          }

          const variant = found.variants?.[0]
          const oldPrice = Number(
            (variant?.metadata as Record<string, string> | null)
              ?.moysklad_price_kopecks || 0
          )
          const coreChanged =
            found.title !== ms.name ||
            (found.description || "") !== (ms.description || "") ||
            (meta.moysklad_article || "") !== (ms.article || "") ||
            (meta.moysklad_code || "") !== (ms.code || "") ||
            (meta.moysklad_path || "") !== (ms.pathName || "") ||
            (meta.moysklad_uom || "") !== uom ||
            oldPrice !== amount ||
            (variant?.sku || "") !== sku

          if (
            coreChanged ||
            meta.moysklad_sync_fp !== syncFp ||
            !pricedOk ||
            !categorizedOk ||
            wasHidden
          ) {
            if (variant) {
              const vMeta = (variant.metadata || {}) as Record<string, string>
              // Сначала реальная цена в Pricing — иначе флаг moysklad_medusa_priced врёт
              await upsertVariantRubPrice(
                container,
                variant.id,
                found.id,
                amount,
                {
                  ...vMeta,
                  moysklad_id: ms.id,
                  moysklad_uom: uom,
                }
              )
              if (coreChanged) {
                await productModule.updateProductVariants(variant.id, {
                  title: ms.name,
                  sku,
                  metadata: {
                    ...vMeta,
                    moysklad_id: ms.id,
                    moysklad_uom: uom,
                  },
                })
              }
            }

            await productModule.updateProducts(found.id, {
              ...(wasHidden ? { status: "published" as const } : {}),
              title: ms.name,
              description: ms.description || found.description || undefined,
              metadata: {
                ...meta,
                moysklad_id: ms.id,
                moysklad_article: ms.article || "",
                moysklad_code: ms.code || "",
                moysklad_path: ms.pathName || "",
                moysklad_uom: uom,
                moysklad_folder: rootFolder,
                moysklad_product_updated: ms.updated || "",
                moysklad_sync_fp: syncFp,
                moysklad_medusa_priced: String(amount),
              },
            })

            if (!categorizedOk) {
              await updateProductsWorkflow(container).run({
                input: {
                  products: [
                    {
                      id: found.id,
                      category_ids: categoryIds,
                    },
                  ],
                },
              })
            }
            updated += 1
          } else if (!needsImage) {
            // Только отпечаток (например updated) — запишем fp без лишних полей
            await productModule.updateProducts(found.id, {
              metadata: {
                ...meta,
                moysklad_uom: uom,
                moysklad_product_updated: ms.updated || "",
                moysklad_sync_fp: syncFp,
              },
            })
            unchanged += 1
          }

          if (needsImage && productId) {
            try {
              const uploaded = await uploadMoySkladImages({
                client,
                fileModule,
                productId: ms.id,
              })
              if (uploaded) {
                await productModule.updateProducts(productId, {
                  thumbnail: uploaded.urls[0],
                  images: uploaded.urls.map((url) => ({ url })),
                  metadata: {
                    ...meta,
                    moysklad_id: ms.id,
                    moysklad_article: ms.article || "",
                    moysklad_code: ms.code || "",
                    moysklad_path: ms.pathName || "",
                    moysklad_uom: uom,
                    moysklad_product_updated: ms.updated || "",
                    moysklad_sync_fp: syncFp,
                    moysklad_image_id: uploaded.sourceIds[0] || "",
                    moysklad_images_count: String(uploaded.urls.length),
                    moysklad_images_fp: uploaded.fingerprint,
                  },
                })
                imagesSynced += uploaded.urls.length
                if (!coreChanged && meta.moysklad_sync_fp === syncFp) {
                  updated += 1
                }
              }
            } catch (imgErr) {
              errors.push(
                `${ms.id} ${ms.name}: фото — ${(imgErr as Error).message}`
              )
            }
          }
        } else {
          const rub = rubFromKopecks(amount)
          const buildPayload = (h: string, s: string) => ({
            title: ms.name,
            handle: h,
            description: ms.description || "",
            status: "published" as const,
            shipping_profile_id: defaultShippingProfileId,
            metadata: {
              moysklad_id: ms.id,
              moysklad_article: ms.article || "",
              moysklad_code: ms.code || "",
              moysklad_path: ms.pathName || "",
              moysklad_uom: uom,
              moysklad_folder: rootFolder,
              moysklad_product_updated: ms.updated || "",
              moysklad_sync_fp: syncFp,
              moysklad_medusa_priced: String(amount),
            },
            options: [{ title: "Default", values: ["Default"] }],
            sales_channels: defaultChannelId
              ? [{ id: defaultChannelId }]
              : undefined,
            categories: categoryIds.map((id) => ({ id })),
            variants: [
              {
                title: ms.name,
                sku: s,
                options: { Default: "Default" },
                manage_inventory: true,
                prices: [{ amount: rub, currency_code: "rub" }],
                metadata: {
                  moysklad_id: ms.id,
                  moysklad_price_kopecks: String(amount),
                  moysklad_medusa_priced: String(amount),
                  moysklad_uom: uom,
                },
              },
            ],
          })

          let createdProduct: { id: string } | undefined
          try {
            const { result } = await createProductsWorkflow(container).run({
              input: { products: [buildPayload(handle, sku)] },
            })
            createdProduct = result[0]
          } catch (createErr) {
            const msg = (createErr as Error).message || ""
            if (!/already exists/i.test(msg)) throw createErr
            const suffix = ms.id.slice(0, 8)
            const { result } = await createProductsWorkflow(container).run({
              input: {
                products: [
                  buildPayload(`${handle}-${suffix}`, `${sku}-${suffix}`),
                ],
              },
            })
            createdProduct = result[0]
          }

          productId = createdProduct?.id
          created += 1

          if (msImageCount > 0 && productId) {
            try {
              const uploaded = await uploadMoySkladImages({
                client,
                fileModule,
                productId: ms.id,
              })
              if (uploaded) {
                await productModule.updateProducts(productId, {
                  thumbnail: uploaded.urls[0],
                  images: uploaded.urls.map((url) => ({ url })),
                  metadata: {
                    moysklad_id: ms.id,
                    moysklad_article: ms.article || "",
                    moysklad_code: ms.code || "",
                    moysklad_path: ms.pathName || "",
                    moysklad_uom: uom,
                    moysklad_product_updated: ms.updated || "",
                    moysklad_sync_fp: syncFp,
                    moysklad_image_id: uploaded.sourceIds[0] || "",
                    moysklad_images_count: String(uploaded.urls.length),
                    moysklad_images_fp: uploaded.fingerprint,
                  },
                })
                imagesSynced += uploaded.urls.length
              }
            } catch (imgErr) {
              errors.push(
                `${ms.id} ${ms.name}: фото — ${(imgErr as Error).message}`
              )
            }
          }
        }
      } catch (e) {
        skipped += 1
        errors.push(`${ms.id} ${ms.name}: ${(e as Error).message}`)
      }
    }

    return new StepResponse({
      created,
      updated,
      unchanged,
      skipped,
      imagesSynced,
      stockUpdated: 0,
      stockUnchanged: 0,
      hidden,
      errors,
    } satisfies SyncResult)
  }
)

/** Шаг: синхронизация остатков — пишем только если количество изменилось */
const syncStockStep = createStep(
  "moysklad-sync-stock",
  async (input: SyncResult, { container }) => {
    const stock = await syncAllMoyskladStock(container)

    return new StepResponse({
      ...input,
      stockUpdated: stock.stockUpdated,
      stockUnchanged: stock.stockUnchanged,
      errors: [...(input.errors || []), ...stock.errors],
    } satisfies SyncResult)
  }
)

export const syncMoyskladCatalogWorkflow = createWorkflow(
  "sync-moysklad-catalog",
  () => {
    const products = syncProductsStep()
    const result = syncStockStep(products)
    return new WorkflowResponse(result)
  }
)

const emptySyncInputStep = createStep(
  "moysklad-sync-stock-empty-input",
  async () => {
    return new StepResponse({
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      imagesSynced: 0,
      stockUpdated: 0,
      stockUnchanged: 0,
      hidden: 0,
      errors: [] as string[],
    } satisfies SyncResult)
  }
)

/** Только остатки из МойСклад → Medusa (для аварийного выравнивания) */
export const syncMoyskladStockWorkflow = createWorkflow(
  "sync-moysklad-stock",
  () => {
    const empty = emptySyncInputStep()
    const result = syncStockStep(empty)
    return new WorkflowResponse(result)
  }
)
