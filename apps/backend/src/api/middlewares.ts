import {
  configureStoreSearch,
  defineMiddlewares,
} from "@medusajs/framework/http"

/**
 * Открываем индекс product для витрины через POST /store/search.
 * Без этого маршрута поиск по индексу недоступен снаружи.
 */
export default defineMiddlewares({
  routes: [
    {
      matcher: "/store/search",
      middlewares: [
        configureStoreSearch({
          allowed_indexes: {
            product: true,
          },
        }),
      ],
    },
  ],
})
