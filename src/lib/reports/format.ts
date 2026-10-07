import type { MoneyTotals } from './overview'

/** `{ DOP: 45000, USD: 300 }` -> `DOP 45,000 + USD 300`; empty -> `0`. */
export function formatMoney(totals: MoneyTotals): string {
  const parts = Object.entries(totals)
    .filter(([, v]) => v > 0)
    .map(([cur, v]) => `${cur} ${Math.round(v).toLocaleString('en-US')}`)
  return parts.length ? parts.join(' + ') : '0'
}

export type DurationUnit = 's' | 'min' | 'h' | 'd'

/** Seconds -> the most readable unit, e.g. 95 -> `{ value: 2, unit: 'min' }`. */
export function durationParts(seconds: number): { value: string; unit: DurationUnit } {
  if (seconds < 60) return { value: String(Math.round(seconds)), unit: 's' }
  if (seconds < 3600) return { value: String(Math.round(seconds / 60)), unit: 'min' }
  const h = seconds / 3600
  if (h < 48) return { value: h.toFixed(1), unit: 'h' }
  return { value: String(Math.round(h / 24)), unit: 'd' }
}

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—'
  const { value, unit } = durationParts(seconds)
  return `${value} ${unit}`
}
