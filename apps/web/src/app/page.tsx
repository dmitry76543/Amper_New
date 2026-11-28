import Image from "next/image"
export const dynamic = "force-dynamic"
import Link from "next/link"
import { ProductCard } from "@/components/ProductCard"
import { Icon } from "@/components/icons"
import {
  categoryImage,
  findCategoryForTask,
  TASKS,
} from "@/lib/catalog-nav"
import {
  STORE_PRODUCT_FIELDS,
  listStoreCategories,
  medusa,
  type StoreProduct,
} from "@/lib/medusa"

async function loadProducts(): Promise<StoreProduct[]> {
  try {
    const { products } = await medusa.store.product.list({
      limit: 6,
      fields: STORE_PRODUCT_FIELDS,
    })
    return (products || []) as StoreProduct[]
  } catch {
    return []
  }
}

function SectionHead({
  eyebrow,
  title,
  href = "/catalog",
  linkTitle = "Смотреть все",
}: {
  eyebrow: string
  title: string
  href?: string
  linkTitle?: string
}) {
  return (
    <div className="section-head">
      <div className="section-head-copy">
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>
      <Link href={href} className="section-more">
        {linkTitle}
      </Link>
    </div>
  )
}

export default async function HomePage() {
  const products = await loadProducts()
  let categories: Awaited<ReturnType<typeof listStoreCategories>> = []
  try {
    categories = await listStoreCategories(true)
  } catch {
    categories = []
  }
  return (
    <>
      <section className="hero-section hero-refresh">
        <div className="frame hero-grid">
          <div className="hero-copy">
            <div className="hero-overline">
              <span className="dot" /> СПЕЦИАЛИЗИРОВАННЫЙ МАГАЗИН
            </div>
            <h1>
              Электрика.
              <br />
              <em>Инструмент.</em>
              <br />
              Крепёж.
            </h1>
            <p>
              Кабель, розетки, автоматика, освещение, инструмент и крепёж — для
              дома и профессионального монтажа.
            </p>
            <div className="hero-actions">
              <Link href="/catalog" className="btn btn-primary">
                Перейти в каталог
              </Link>
              <Link href="/by-list" className="btn btn-secondary">
                Купить по списку
              </Link>
            </div>
            <div className="hero-bottom">
              <span>
                <Icon name="check" /> Для дома и дачи
              </span>
              <span>
                <Icon name="check" /> Для профессиональных задач
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="frame tasks section-space">
        <div className="task-head">
          <span className="eyebrow">БЫСТРЫЙ СТАРТ</span>
          <strong>Что нужно сделать?</strong>
          <span>Выберите задачу, а мы покажем подходящую категорию</span>
        </div>
        <div className="task-grid">
          {TASKS.map((t) => {
            const cat = findCategoryForTask(categories, t.nameHint)
            const href = cat
              ? `/catalog?cat=${encodeURIComponent(cat.handle)}`
              : "/catalog"
            return (
              <Link key={t.title} href={href} className="task-item">
                <span className="task-img">
                  <Image src={t.image} alt="" width={63} height={63} />
                </span>
                <span>
                  <strong>{t.title}</strong>
                  <small>{t.hint}</small>
                </span>
              </Link>
            )
          })}
        </div>
      </section>

      <section className="frame categories section-space">
        <SectionHead eyebrow="КАТАЛОГ" title="Всё по категориям" />
        <div className="category-grid">
          {categories.map((c, i) => (
            <Link
              key={c.id}
              href={`/catalog?cat=${encodeURIComponent(c.handle)}`}
              className="category-card"
            >
              <Image
                src={categoryImage(c.name, i)}
                alt=""
                width={420}
                height={280}
                loading="lazy"
              />
              <div className="category-bottom">
                <h3>{c.name}</h3>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="frame products section-space">
        <SectionHead
          eyebrow="ПОПУЛЯРНЫЕ КАТЕГОРИИ"
          title="Начните с нужного товара"
        />
        {products.length ? (
          <div className="product-grid">
            {products.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        ) : (
          <div className="empty-state">Товаров пока нет.</div>
        )}
      </section>

      <section className="frame purchase-paths section-space">
        <div className="section-head">
          <div className="section-head-copy">
            <span className="eyebrow">ДВА ДОПОЛНИТЕЛЬНЫХ СЦЕНАРИЯ</span>
            <h2>Покупайте удобным способом</h2>
            <p>
              Для повседневных покупок — каталог выше. Если материалов много или
              есть готовый список — мы предусмотрели отдельные пути.
            </p>
          </div>
        </div>
        <div className="path-grid">
          <Link href="/by-list" className="path-card list-card">
            <span className="path-kicker">ПОКУПАТЕЛЮ СО СПИСКОМ</span>
            <div className="path-graphic path-paper">
              <Icon name="file" />
              <div>
                <i />
                <i />
                <i />
              </div>
            </div>
            <h3>
              Мастер уже написал,
              <br />
              что купить?
            </h3>
            <p>
              Прикрепите фото или вставьте список — покажем, как будет выглядеть
              заявка на подбор.
            </p>
            <span className="path-cta">
              Купить по списку
            </span>
          </Link>
          <Link href="/pro" className="path-card pro-card">
            <span className="path-kicker">ЭЛЕКТРИКАМ И ПРОРАБАМ</span>
            <div className="path-graphic path-pro">
              <Icon name="grid" />
              <span>PRO / 01</span>
            </div>
            <h3>
              Закупка материалов
              <br />
              на объект?
            </h3>
            <p>
              Добавьте спецификацию и запросите расчёт комплектации в отдельном
              интерфейсе.
            </p>
            <span className="path-cta">
              Для профессионалов
            </span>
          </Link>
        </div>
      </section>

      <section className="service-band">
        <div className="frame service-grid">
          <div>
            <Icon name="search" />
            <strong>Поиск по артикулу</strong>
            <span>Быстро найдите нужную позицию</span>
          </div>
          <div>
            <Icon name="truck" />
            <strong>Получение покупки</strong>
            <span>Условия выдачи и доставки уточняются</span>
          </div>
          <div>
            <Icon name="file" />
            <strong>Покупка по списку</strong>
            <span>Не нужно разбирать обозначения самому</span>
          </div>
        </div>
      </section>
    </>
  )
}
