import { defineRouteConfig } from "@medusajs/admin-sdk"
import { History } from "@medusajs/icons"
import {
  Badge,
  Button,
  Container,
  Heading,
  Table,
  Text,
  toast,
} from "@medusajs/ui"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { sdk } from "../../lib/sdk"

type OpsLogKind = "catalog" | "stock" | "force-align" | "search-reindex"

type OpsLogEntry = {
  id: string
  at: string
  kind: OpsLogKind
  status: "ok" | "error"
  trigger?: string
  startedAt?: string
  finishedAt?: string
  durationMs?: number
  summary?: string
  error?: string
  stats?: Record<string, number | undefined>
}

type OpsLogResponse = {
  entries: OpsLogEntry[]
  retentionDays: number
  maxEntries: number
}

const KIND_LABEL: Record<OpsLogKind | "all", string> = {
  all: "Все",
  catalog: "Каталог",
  stock: "Остатки",
  "force-align": "Выравнивание",
  "search-reindex": "Поиск",
}

const TRIGGER_LABEL: Record<string, string> = {
  manual: "вручную",
  schedule: "по расписанию",
  nightly: "ночной",
  cli: "из консоли",
  webhook: "webhook",
}

function fmt(iso?: string) {
  if (!iso) return "—"
  try {
    return new Date(iso).toLocaleString("ru-RU")
  } catch {
    return iso
  }
}

function fmtDuration(ms?: number) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—"
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m <= 0) return `${s} с`
  return `${m} мин ${s.toString().padStart(2, "0")} с`
}

const LOG_RULES: Array<{ what: string; when: string }> = [
  {
    what: "Ручные операции (синк, выравнивание, пересборка поиска)",
    when: "всегда",
  },
  {
    what: "Ночной тяжёлый каталог и ночной поиск",
    when: "всегда",
  },
  {
    what: "Период каталога (~15 мин)",
    when: "ошибка всегда; успех — только если были изменения",
  },
  {
    what: "Страховка остатков (~2 мин)",
    when: "только ошибки (успех без шума — смотри «последняя сверка» на МойСклад)",
  },
]

const MoyskladLogsPage = () => {
  const [kind, setKind] = useState<"all" | OpsLogKind>("all")
  const [showRules, setShowRules] = useState(false)

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ["moysklad-ops-log", kind],
    queryFn: () => {
      const q = new URLSearchParams({ limit: "150" })
      if (kind !== "all") q.set("kind", kind)
      return sdk.client.fetch<OpsLogResponse>(
        `/admin/moysklad/ops-log?${q.toString()}`
      )
    },
    refetchInterval: 15_000,
  })

  const entries = data?.entries || []
  const retention = data?.retentionDays ?? 30

  const emptyHint = useMemo(() => {
    if (isLoading) return "Загрузка…"
    return "Пока записей нет — появятся после синка, выравнивания, страховки остатков или пересборки поиска."
  }, [isLoading])

  const buildLogText = () => {
    const header = [
      "когда",
      "что",
      "статус",
      "длительность",
      "триггер",
      "описание",
      "детали",
    ].join("\t")
    const rows = entries.map((e) => {
      const stats =
        e.stats &&
        Object.entries(e.stats)
          .filter(([, v]) => typeof v === "number")
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      return [
        fmt(e.at || e.finishedAt),
        KIND_LABEL[e.kind] || e.kind,
        e.status === "ok" ? "успешно" : "ошибка",
        fmtDuration(e.durationMs),
        e.trigger ? TRIGGER_LABEL[e.trigger] || e.trigger : "",
        e.summary || "",
        e.error || stats || "",
      ].join("\t")
    })
    return [
      `МойСклад · логи · ${new Date().toLocaleString("ru-RU")}`,
      `Фильтр: ${KIND_LABEL[kind]} · записей: ${entries.length}`,
      "",
      header,
      ...rows,
    ].join("\n")
  }

  const copyLogText = async () => {
    if (!entries.length) {
      toast.error("Нечего копировать — журнал пуст")
      return
    }
    try {
      await navigator.clipboard.writeText(buildLogText())
      toast.success("Журнал скопирован в буфер обмена")
    } catch {
      toast.error("Не удалось скопировать в буфер")
    }
  }

  const downloadLogFile = () => {
    if (!entries.length) {
      toast.error("Нечего выгружать — журнал пуст")
      return
    }
    const stamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19)
    const name = `moysklad-ops-log-${kind}-${stamp}.txt`
    // BOM — чтобы Excel/Блокнот на Windows нормально открыли кириллицу
    const blob = new Blob(["\uFEFF" + buildLogText()], {
      type: "text/plain;charset=utf-8",
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`Скачан файл ${name}`)
  }

  return (
    <Container className="p-0 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4 flex-wrap px-6 pt-6">
        <div className="flex flex-col gap-1">
          <Heading level="h1">МойСклад · логи</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Журнал запусков за последние {retention} дней: каталог, выравнивание,
            страховка остатков, поиск. Файл на постоянном томе рядом со статусом
            синка.
          </Text>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="secondary"
            onClick={() => setShowRules((v) => !v)}
          >
            {showRules ? "Скрыть инструкцию" : "Что пишется в журнал"}
          </Button>
          <Button
            variant="secondary"
            disabled={!entries.length}
            onClick={() => void copyLogText()}
          >
            Копировать в буфер
          </Button>
          <Button
            variant="secondary"
            disabled={!entries.length}
            onClick={downloadLogFile}
          >
            Выгрузить файл
          </Button>
          <Button
            variant="secondary"
            isLoading={isFetching}
            onClick={() => refetch()}
          >
            Обновить
          </Button>
        </div>
      </div>

      {showRules ? (
        <div className="mx-6 rounded-lg border border-ui-border-base p-4 flex flex-col gap-3">
          <Text weight="plus">Что пишется в журнал</Text>
          <Text size="small" className="text-ui-fg-subtle">
            Хранение: последние {retention} дней (потолок по числу записей). Цель —
            фиксировать важные запуски и ошибки, без шума каждые 2 минуты.
          </Text>
          <div className="rounded-md border border-ui-border-base overflow-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Вид операции</Table.HeaderCell>
                  <Table.HeaderCell>В журнал</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {LOG_RULES.map((row) => (
                  <Table.Row key={row.what}>
                    <Table.Cell>
                      <Text size="small">{row.what}</Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="small">{row.when}</Text>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        </div>
      ) : null}

      <div className="px-6 flex items-center gap-3 flex-wrap">
        <Text size="small" className="text-ui-fg-subtle">
          Фильтр:
        </Text>
        {(
          [
            "all",
            "catalog",
            "force-align",
            "stock",
            "search-reindex",
          ] as const
        ).map((k) => (
          <Button
            key={k}
            size="small"
            variant={kind === k ? "primary" : "secondary"}
            onClick={() => setKind(k)}
          >
            {KIND_LABEL[k]}
          </Button>
        ))}
        <Badge color="grey">{entries.length} записей</Badge>
      </div>

      <div className="px-6 pb-6">
        {entries.length === 0 ? (
          <div className="rounded-lg border border-ui-border-base p-6">
            <Text size="small" className="text-ui-fg-subtle">
              {emptyHint}
            </Text>
          </div>
        ) : (
          <div className="rounded-lg border border-ui-border-base overflow-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.HeaderCell>Когда</Table.HeaderCell>
                  <Table.HeaderCell>Что</Table.HeaderCell>
                  <Table.HeaderCell>Статус</Table.HeaderCell>
                  <Table.HeaderCell>Длительность</Table.HeaderCell>
                  <Table.HeaderCell>Детали</Table.HeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {entries.map((e) => (
                  <Table.Row key={e.id}>
                    <Table.Cell>
                      <Text size="small">{fmt(e.at || e.finishedAt)}</Text>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge color="blue">
                            {KIND_LABEL[e.kind] || e.kind}
                          </Badge>
                          {e.trigger ? (
                            <Badge color="grey">
                              {TRIGGER_LABEL[e.trigger] || e.trigger}
                            </Badge>
                          ) : null}
                        </div>
                        {e.summary ? (
                          <Text size="small" className="text-ui-fg-subtle">
                            {e.summary}
                          </Text>
                        ) : null}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge color={e.status === "ok" ? "green" : "red"}>
                        {e.status === "ok" ? "успешно" : "ошибка"}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="small">{fmtDuration(e.durationMs)}</Text>
                    </Table.Cell>
                    <Table.Cell>
                      {e.status === "error" && e.error ? (
                        <Text size="small" className="text-ui-fg-error">
                          {e.error}
                        </Text>
                      ) : e.stats ? (
                        <Text size="small" className="text-ui-fg-subtle">
                          {Object.entries(e.stats)
                            .filter(([, v]) => typeof v === "number")
                            .map(([k, v]) => `${k}=${v}`)
                            .join(" · ") || "—"}
                        </Text>
                      ) : (
                        <Text size="small" className="text-ui-fg-subtle">
                          —
                        </Text>
                      )}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        )}
      </div>
    </Container>
  )
}

export const config = defineRouteConfig({
  label: "МойСклад логи",
  icon: History,
})

export default MoyskladLogsPage
