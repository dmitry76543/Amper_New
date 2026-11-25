/** Remap updated timestamps are Moscow wall time, without ISO T/Z separators. */
export function toMoySkladDateTime(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid MoySklad filter date")
  return new Date(date.getTime() + 3 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 23)
}
