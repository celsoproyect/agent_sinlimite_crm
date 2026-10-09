// ============================================================
// Leads → Oportunidades: every deal of the account, across all
// pipelines. Pure helpers (filters, summary, CSV) shared by the page and
// the tests; the loader lives in load.ts (server only). Dates are
// business-local days (America/Santo_Domingo).
// ============================================================

import { businessDate } from '@/lib/business-timezone'
import { addDaysISO, type DayRange } from '@/lib/bookings/ranges'
import type { Deal, Pipeline, PipelineStage } from '@/types'

export type LeadStatus = 'open' | 'won' | 'lost'
/** Where the contact came from: its first conversation's channel, or the
 *  web form when it only has a form submission. */
export type LeadSource = 'whatsapp' | 'web' | 'form'

export interface LeadDeal extends Deal {
  /** status, falling back to the stage kind for old rows. */
  lead_status: LeadStatus
  source: LeadSource | null
}

export interface LeadsPayload {
  deals: LeadDeal[]
  pipelines: Pick<Pipeline, 'id' | 'name'>[]
  stages: PipelineStage[]
}

export type StatusFilter = 'all' | LeadStatus
export type DateField = 'created' | 'closed'
export type RangeKind = 'month' | 'lastMonth' | 'last30' | 'last90' | 'year' | 'all' | 'custom'

export const RANGE_KINDS: Exclude<RangeKind, 'custom'>[] = ['month', 'lastMonth', 'last30', 'last90', 'year', 'all']

export function rangeFor(kind: RangeKind, custom: DayRange, today: string): DayRange | null {
  const monthStart = `${today.slice(0, 7)}-01`
  switch (kind) {
    case 'month':
      return { from: monthStart, to: today }
    case 'lastMonth': {
      const lastDay = addDaysISO(monthStart, -1)
      return { from: `${lastDay.slice(0, 7)}-01`, to: lastDay }
    }
    case 'last30':
      return { from: addDaysISO(today, -29), to: today }
    case 'last90':
      return { from: addDaysISO(today, -89), to: today }
    case 'year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today }
    case 'all':
      return null
    case 'custom':
      return custom.from > custom.to ? { from: custom.to, to: custom.from } : custom
  }
}

/** Business-local day the deal closed, or null while it's open. Deals
 *  closed before migration 063 have no closed_at; their last update
 *  stands in. */
export function closedDay(d: Deal & { lead_status: LeadStatus }): string | null {
  if (d.lead_status === 'open') return null
  return businessDate(d.closed_at || d.updated_at || d.created_at)
}

export function createdDay(d: Deal): string {
  return businessDate(d.created_at)
}

export interface LeadFilters {
  status: StatusFilter
  dateField: DateField
  range: DayRange | null
  pipelineId: string // 'all' or an id
  reason: string // 'all' or a LOST_REASONS key
  query: string
}

export function filterLeads(deals: LeadDeal[], f: LeadFilters): LeadDeal[] {
  const q = f.query.trim().toLowerCase()
  const qDigits = q.replace(/\D/g, '')
  return deals.filter((d) => {
    if (f.status !== 'all' && d.lead_status !== f.status) return false
    if (f.pipelineId !== 'all' && d.pipeline_id !== f.pipelineId) return false
    if (f.reason !== 'all' && (d.lead_status !== 'lost' || (d.lost_reason || 'other') !== f.reason)) return false
    if (f.range) {
      const day = f.dateField === 'closed' ? closedDay(d) : createdDay(d)
      if (!day || day < f.range.from || day > f.range.to) return false
    }
    if (q) {
      const hay = [d.title, d.contact?.name, d.contact?.email, d.close_note, d.notes].join(' ').toLowerCase()
      if (!hay.includes(q)) {
        if (qDigits.length < 3) return false
        if (!(d.contact?.phone ?? '').replace(/\D/g, '').includes(qDigits)) return false
      }
    }
    return true
  })
}

export interface LeadSummary {
  total: number
  open: number
  won: number
  lost: number
  /** won / (won + lost), 0..100, or null with nothing closed. */
  winRate: number | null
  /** Won value per currency. */
  wonValue: Record<string, number>
}

export function summarizeLeads(deals: LeadDeal[], defaultCurrency: string): LeadSummary {
  let open = 0
  let won = 0
  let lost = 0
  const wonValue: Record<string, number> = {}
  for (const d of deals) {
    if (d.lead_status === 'won') {
      won++
      const cur = d.currency || defaultCurrency
      wonValue[cur] = (wonValue[cur] ?? 0) + Number(d.value || 0)
    } else if (d.lead_status === 'lost') lost++
    else open++
  }
  const closed = won + lost
  return {
    total: deals.length,
    open,
    won,
    lost,
    winRate: closed > 0 ? Math.round((won / closed) * 100) : null,
    wonValue,
  }
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV of the rows, with already-translated headers and labels. */
export function leadsToCsv(
  deals: LeadDeal[],
  opts: {
    headers: string[]
    pipelineName: (id: string) => string
    stageName: (id: string) => string
    statusLabel: (s: LeadStatus) => string
    reasonLabel: (r: string | null | undefined) => string
    sourceLabel: (s: LeadSource | null) => string
  },
): string {
  const lines = [opts.headers.map(csvCell).join(',')]
  for (const d of deals) {
    lines.push(
      [
        d.contact?.name || '',
        d.contact?.phone || '',
        d.contact?.email || '',
        d.title,
        opts.pipelineName(d.pipeline_id),
        opts.stageName(d.stage_id),
        opts.statusLabel(d.lead_status),
        Number(d.value || 0),
        d.currency || '',
        d.lead_status === 'lost' ? opts.reasonLabel(d.lost_reason) : '',
        createdDay(d),
        closedDay(d) ?? '',
        opts.sourceLabel(d.source),
      ]
        .map(csvCell)
        .join(','),
    )
  }
  // BOM so Excel opens the accents correctly.
  return '﻿' + lines.join('\r\n')
}
