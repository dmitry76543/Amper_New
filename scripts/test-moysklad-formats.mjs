import assert from "node:assert/strict"
import { createRequire } from "node:module"
const require = createRequire(import.meta.url)
const base = "../apps/backend/.medusa/server/src/modules/moysklad/"
const { toMoySkladDateTime } = require(`${base}date-format.js`)
const { default: Service } = require(`${base}service.js`)
const { MoySkladClient } = require(`${base}client.js`)
const { toCategoryHandle } = require(`${base}category-utils.js`)
const { isValidHandle } = require("@medusajs/framework/utils")
assert.equal(toMoySkladDateTime(new Date("2026-11-24T11:30:32.000Z")), "2026-11-24 14:30:32.000")
assert.equal(toMoySkladDateTime(new Date("2026-12-31T22:15:00.123Z")), "2027-01-01 01:15:00.123")
assert.throws(() => toMoySkladDateTime(new Date("bad")), /Invalid/)
const client = new MoySkladClient({ apiToken: "test", apiUrl: "https://example.invalid" })
let requested
client.listAll = async (url) => { requested = new URL(url, "https://example.invalid"); return [] }
await client.listCustomerOrdersUpdatedSince(new Date("2026-11-24T11:52:16.000Z"))
assert.equal(requested.searchParams.get("filter"), "updated>2026-11-24 14:52:16.000")
const service = Object.create(Service.prototype)
const id = "53412451-b832-11e9-9ff4-315000054197"
for (const article of ["a".repeat(119) + " / more", "!!!", "Тест / лампа", "SL-S-FSP-15/2700/E14-N Данная информация скопирована со страницы https://spb.vseinstrumenti.ru/electrika-i-svet/lampy/".repeat(2)]) {
  const handle = service.toHandle({ id, name: "Test", article })
  assert.ok(isValidHandle(handle), handle)
  assert.ok(handle.length <= 120)
}
assert.equal(service.toHandle({ id, name: "Test", code: "ABC-123" }), "abc-123")
assert.ok(isValidHandle(toCategoryHandle("a".repeat(99) + " / more")))
console.log("PASS: MSK date filter, UTC year rollover, invalid dates, encoded request, truncated/empty/Unicode slugs, unchanged valid handles")
