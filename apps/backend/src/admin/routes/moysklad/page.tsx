import { defineRouteConfig } from "@medusajs/admin-sdk"
import { ArrowPath, CloudArrowDown } from "@medusajs/icons"
import {
  Badge,
  Button,
  Container,
  Heading,
  Input,
  Label,
  Text,
  toast,
} from "@medusajs/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"
import { sdk } from "../../lib/sdk"

type SyncState = {
  status: "idle" | "running" | "ok" | "error"
  intervalMinutes: number
  stockIntervalMinutes?: number
  trigger?: "manual" | "schedule" | "cli" | "webhook"
  startedAt?: string
  finishedAt?: string
  nextDueAt?: string
  runningForMs?: number
  lastStockSyncAt?: string
  lastStockDurationMs?: number
  stockRequestedAt?: string
  stockError?: string
  result?: {
    created?: number
    updated?: number
    unchanged?: number
    skipped?: number
    imagesSynced?: number
    stockUpdated?: number
    stockUnchanged?: number
    hidden?: number
    reservationsCleared?: number
    errors?: string[]
  }
  error?: string
}

type SyncResponse = {
  message?: string
  sync: SyncState
}

const TRIGGER_LABEL: Record<string, string> = {
  manual: "вручную",
  schedule: "по расписанию",
  cli: "из консоли",
  webhook: "webhook",
}

const LAST_RUN_LABEL: Record<string, string> = {
  idle: "запусков ещё не было",
  running: "ещё выполняется",
  ok: "успешно",
  error: "с ошибкой",
}

const MoyskladPage = () => {
  const queryClient = useQueryClient()
  const [intervalDraft, setIntervalDraft] = useState("15")
  const [stockIntervalDraft, setStockIntervalDraft] = useState("2")
  const [nowTick, setNowTick] = useState(() => Date.now())

  const { data, isLoading } = useQuery({
    queryKey: ["moysklad-sync-status"],
    queryFn: () => sdk.client.fetch<SyncResponse>("/admin/moysklad/sync"),
    refetchInterval: 3000,
  })

  const sync = data?.sync

  useEffect(() => {
    if (sync?.intervalMinutes) {
      setIntervalDraft(String(sync.intervalMinutes))
    }
  }, [sync?.intervalMinutes])

  useEffect(() => {
    if (sync?.stockIntervalMinutes) {
      setStockIntervalDraft(String(sync.stockIntervalMinutes))
    }
  }, [sync?.stockIntervalMinutes])

  // Живой таймер длительности, пока status=running
  useEffect(() => {
    if (sync?.status !== "running") return
    const id = window.setInterval(() => setNowTick(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [sync?.status])

  const runMutation = useMutation({
    mutationFn: () =>
      sdk.client.fetch<SyncResponse>("/admin/moysklad/sync", {
        method: "POST",
        body: { action: "sync" },
      }),
    onSuccess: (res) => {
      toast.success(res.message || "Синхронизация запущена")
      queryClient.invalidateQueries({ queryKey: ["moysklad-sync-status"] })
    },
    onError: (err: Error) => {
      toast.error(err.message || "Не удалось запустить синхронизацию")
    },
  })

  const forceAlignMutation = useMutation({
    mutationFn: () =>
      sdk.client.fetch<SyncResponse>("/admin/moysklad/sync", {
        method: "POST",
        body: { action: "force-align" },
      }),
    onSuccess: (res) => {
      toast.success(res.message || "Выравнивание запущено")
      queryClient.invalidateQueries({ queryKey: ["moysklad-sync-status"] })
    },
    onError: (err: Error) => {
      toast.error(err.message || "Не удалось запустить выравнивание")
    },
  })

  const settingsMutation = useMutation({
    mutationFn: (body: {
      intervalMinutes?: number
      stockIntervalMinutes?: number
    }) =>
      sdk.client.fetch<SyncResponse>("/admin/moysklad/sync", {
        method: "POST",
        body: { action: "settings", ...body },
      }),
    onSuccess: (res) => {
      toast.success(res.message || "Настройки сохранены")
      queryClient.invalidateQueries({ queryKey: ["moysklad-sync-status"] })
    },
    onError: (err: Error) => {
      toast.error(err.message || "Не удалось сохранить настройки")
    },
  })

  const running =
    sync?.status === "running" ||
    runMutation.isPending ||
    forceAlignMutation.isPending

  const result = sync?.result
  const startedMs = sync?.startedAt ? new Date(sync.startedAt).getTime() : NaN
  const runningForMs =
    sync?.status === "running" && Number.isFinite(startedMs)
      ? Math.max(0, nowTick - startedMs)
      : sync?.runningForMs

  function confirmForceAlign() {
    const ok = window.confirm(
      "Выровнять остатки Medusa по МойСклад?\n\n" +
        "• снимет локальные резервы на складе Medusa\n" +
        "• перепишет количества строго как в МойСклад\n\n" +
        "В МойСклад ничего не пишет. Только для крайних случаев после тестов."
    )
    if (ok) forceAlignMutation.mutate()
  }

  function saveInterval() {
    const n = Number(intervalDraft)
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      toast.error("Интервал каталога: от 1 до 1440 минут")
      return
    }
    settingsMutation.mutate({ intervalMinutes: n })
  }

  function saveStockInterval() {
    const n = Number(stockIntervalDraft)
    if (!Number.isFinite(n) || n < 1 || n > 60) {
      toast.error("Интервал остатков: от 1 до 60 минут")
      return
    }
    settingsMutation.mutate({ stockIntervalMinutes: n })
  }

  const status = sync?.status || "idle"

  return (
    <Container className="divide-y p-0">
      <div className="flex flex-col px-6 py-4 gap-4">
        <div>
          <Heading level="h1">МойСклад</Heading>
          <Text size="small" className="text-ui-fg-subtle">
            Синхронизация каталога, цен, фотографий и остатков. Автозапуск
            работает по интервалу, указанному ниже.
          </Text>
        </div>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <Button
            variant="primary"
            isLoading={running}
            disabled={running}
            onClick={() => runMutation.mutate()}
          >
            <CloudArrowDown />
            {status === "error"
              ? "Повторить синхронизацию"
              : "Синхронизировать сейчас"}
          </Button>
          <div className="ml-auto flex max-w-md flex-col items-end gap-1">
            <Button
              variant="danger"
              isLoading={forceAlignMutation.isPending}
              disabled={running}
              onClick={confirmForceAlign}
            >
              <ArrowPath />
              Выровнять по МойСклад
            </Button>
            <Text size="xsmall" className="text-right text-ui-fg-subtle">
              Аварийное действие: снимает локальные резервы Medusa и
              принудительно переписывает остатки по данным МойСклад. Для обычной
              синхронизации каталога не используйте.
            </Text>
          </div>
        </div>
      </div>

      <div className="px-6 py-4 flex flex-col gap-4">
        <div className="rounded-lg border border-ui-border-base p-4 flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Text weight="plus">Сейчас</Text>
            {isLoading ? (
              <Badge>загрузка…</Badge>
            ) : status === "running" ? (
              <div className="flex items-center gap-2 flex-wrap">
                <Badge color="orange">синхронизация выполняется</Badge>
                {sync?.trigger ? (
                  <Badge color="blue">
                    {TRIGGER_LABEL[sync.trigger] || sync.trigger}
                  </Badge>
                ) : null}
                {typeof runningForMs === "number" ? (
                  <Text
                    size="small"
                    className="text-ui-fg-subtle flex items-center gap-1"
                  >
                    <ArrowPath className="animate-spin" /> уже{" "}
                    {fmtDuration(runningForMs)}
                  </Text>
                ) : null}
              </div>
            ) : (
              <div className="flex items-center gap-2 flex-wrap">
                <Badge color="green">не выполняется</Badge>
                <Badge color="green">автозапуск включён</Badge>
              </div>
            )}
            <Text size="small" className="text-ui-fg-subtle">
              {status === "running"
                ? "Идёт обновление каталога, цен, фотографий и остатков из МойСклад."
                : sync?.nextDueAt
                  ? `Следующий автозапуск примерно: ${fmt(sync.nextDueAt)}`
                  : "Автозапуск ждёт ближайшего интервала."}
            </Text>
            {status === "running" && sync?.startedAt ? (
              <Text size="small" className="text-ui-fg-subtle">
                Текущий запуск начат: {fmt(sync.startedAt)}
              </Text>
            ) : null}
          </div>

          <div className="border-t border-ui-border-base pt-4 flex flex-col gap-2">
            <Text weight="plus">Последний запуск</Text>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                color={
                  status === "ok"
                    ? "green"
                    : status === "error"
                      ? "red"
                      : status === "running"
                        ? "orange"
                        : "grey"
                }
              >
                {LAST_RUN_LABEL[status]}
              </Badge>
              {sync?.trigger && status !== "running" ? (
                <Badge color="blue">
                  {TRIGGER_LABEL[sync.trigger] || sync.trigger}
                </Badge>
              ) : null}
            </div>
            {sync?.startedAt && status !== "running" ? (
              <Text size="small" className="text-ui-fg-subtle">
                Начат: {fmt(sync.startedAt)}
                {sync.finishedAt ? ` · завершён: ${fmt(sync.finishedAt)}` : ""}
                {sync.finishedAt
                  ? ` · длился ${fmtDuration(
                      Math.max(
                        0,
                        new Date(sync.finishedAt).getTime() -
                          new Date(sync.startedAt).getTime()
                      )
                    )}`
                  : ""}
              </Text>
            ) : !sync?.startedAt ? (
              <Text size="small" className="text-ui-fg-subtle">
                Истории запусков пока нет.
              </Text>
            ) : (
              <Text size="small" className="text-ui-fg-subtle">
                Итог появится после завершения текущего запуска.
              </Text>
            )}
            {status === "error" && sync?.error ? (
              <div className="flex flex-col gap-1">
                <Text size="small" className="text-ui-fg-error">
                  Причина: {sync.error}
                </Text>
                <Text size="small" className="text-ui-fg-subtle">
                  Что делать: нажмите «Повторить синхронизацию». Если ошибка
                  повторится, сохраните её текст.
                </Text>
              </div>
            ) : null}
            {status === "ok" ? (
              <Text size="small" className="text-ui-fg-subtle">
                Последняя синхронизация завершилась без ошибок.
              </Text>
            ) : null}
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-ui-border-base p-4 flex flex-col gap-3">
            <Text weight="plus">Интервал каталога</Text>
            <Text size="small" className="text-ui-fg-subtle">
              Полный умный синк: товары, цены, фотографии, категории.
            </Text>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="ms-interval">Минут</Label>
                <Input
                  id="ms-interval"
                  type="number"
                  min={1}
                  max={1440}
                  value={intervalDraft}
                  onChange={(e) => setIntervalDraft(e.target.value)}
                />
              </div>
              <Button
                variant="secondary"
                isLoading={settingsMutation.isPending}
                onClick={saveInterval}
              >
                Сохранить
              </Button>
            </div>
            <Text size="xsmall" className="text-ui-fg-subtle">
              Сейчас: каждые {sync?.intervalMinutes ?? 15} мин.
            </Text>
          </div>

          <div className="rounded-md border border-ui-border-base p-4 flex flex-col gap-3">
            <Text weight="plus">Страховка остатков</Text>
            <Text size="small" className="text-ui-fg-subtle">
              Лёгкая проверка изменений. Если webhook потерялся — догонит сама.
            </Text>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="ms-stock-interval">Минут</Label>
                <Input
                  id="ms-stock-interval"
                  type="number"
                  min={1}
                  max={60}
                  value={stockIntervalDraft}
                  onChange={(e) => setStockIntervalDraft(e.target.value)}
                />
              </div>
              <Button
                variant="secondary"
                isLoading={settingsMutation.isPending}
                onClick={saveStockInterval}
              >
                Сохранить
              </Button>
            </div>
            <Text size="xsmall" className="text-ui-fg-subtle">
              Сейчас: каждые {sync?.stockIntervalMinutes ?? 2} мин.
              {sync?.lastStockSyncAt
                ? ` · последняя сверка: ${fmt(sync.lastStockSyncAt)}`
                : ""}
              {typeof sync?.lastStockDurationMs === "number"
                ? ` · длилась ${fmtDuration(sync.lastStockDurationMs)}`
                : ""}
              {sync?.stockRequestedAt ? " · есть срочный запрос" : ""}
            </Text>
            {sync?.stockError ? (
              <Text size="small" className="text-ui-fg-error">
                Ошибка остатков: {sync.stockError}
              </Text>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Text weight="plus">Итог последнего прогона</Text>
          {result ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Создано" value={result.created} />
              <Stat label="Обновлено" value={result.updated} />
              <Stat label="Без изменений" value={result.unchanged} />
              <Stat label="Ошибки товаров" value={result.skipped} />
              <Stat label="Фото загружено" value={result.imagesSynced} />
              <Stat label="Остатки обновлены" value={result.stockUpdated} />
              <Stat label="Остатки без изменений" value={result.stockUnchanged} />
              <Stat label="Скрыто из каталога" value={result.hidden} />
              {typeof result.reservationsCleared === "number" ? (
                <Stat label="Снято резервов" value={result.reservationsCleared} />
              ) : null}
              <Stat
                label="Сообщений об ошибках"
                value={result.errors?.length || 0}
              />
            </div>
          ) : (
            <Text size="small" className="text-ui-fg-subtle">
              Данных о завершённой синхронизации пока нет.
            </Text>
          )}
        </div>

        {result?.errors?.length ? (
          <div className="max-h-48 overflow-auto rounded-md border border-ui-border-base p-3">
            <Text size="small" weight="plus">
              Первые ошибки
            </Text>
            <ul className="mt-2 list-disc pl-4">
              {result.errors.slice(0, 20).map((e, i) => (
                <li key={i}>
                  <Text size="small">{e}</Text>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Container>
  )
}

function fmt(iso: string) {
  try {
    return new Date(iso).toLocaleString("ru-RU")
  } catch {
    return iso
  }
}

function fmtDuration(ms: number) {
  const totalSec = Math.floor(ms / 1000)
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m <= 0) return `${s} с`
  return `${m} мин ${s.toString().padStart(2, "0")} с`
}

const Stat = ({ label, value }: { label: string; value?: number }) => (
  <div className="rounded-md border border-ui-border-base px-3 py-2">
    <Text size="xsmall" className="text-ui-fg-subtle">
      {label}
    </Text>
    <Text weight="plus">{value ?? "—"}</Text>
  </div>
)

export const config = defineRouteConfig({
  label: "МойСклад",
  icon: CloudArrowDown,
})

export default MoyskladPage
