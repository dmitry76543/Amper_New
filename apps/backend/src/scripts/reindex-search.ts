import type { ExecArgs } from "@medusajs/framework/types"
import { runProductSearchReindex } from "../modules/search-reindex/run"

/**
 * Разовая пересборка поиска из консоли / Amvera:
 * npx medusa exec ./src/scripts/reindex-search.js
 */
export default async function reindexSearch({ container }: ExecArgs) {
  const result = await runProductSearchReindex(container, "cli")
  console.log(result)
  if (!result.ok) {
    throw new Error(result.message)
  }
}
