import { describe, expect, it } from 'vitest'
import { filterLeads, leadsToCsv, rangeFor, summarizeLeads, type LeadDeal, type LeadFilters } from './opportunities'
import { isMissingTableError, rawSubmissionFields } from './submissions'

function deal(over: Partial<LeadDeal>): LeadDeal {
  return {
    id: 'd',
    user_id: 'u',
    pipeline_id: 'p1',
    stage_id: 's1',
    contact_id: 'c1',
    title: 'Deal',
    value: 0,
    currency: 'USD',
    created_at: '2026-10-01T15:00:00Z',
    lead_status: 'open',
    source: null,
    ...over,
  } as LeadDeal
}

const ALL: LeadFilters = { status: 'all', dateField: 'created', range: null, pipelineId: 'all', reason: 'all', query: '' }

describe('leads opportunities', () => {
  const deals = [
    deal({ id: 'a', lead_status: 'won', value: 100, closed_at: '2026-10-05T12:00:00Z' }),
    deal({ id: 'b', lead_status: 'lost', lost_reason: 'price', closed_at: '2026-09-10T12:00:00Z', pipeline_id: 'p2' }),
    deal({ id: 'c', lead_status: 'open', title: 'Clínica Sol', created_at: '2026-09-01T12:00:00Z' }),
    deal({ id: 'd', lead_status: 'won', value: 50, currency: 'DOP', closed_at: '2026-10-06T12:00:00Z' }),
  ]

  it('filters by status, pipeline, reason and text', () => {
    expect(filterLeads(deals, { ...ALL, status: 'won' }).map((d) => d.id)).toEqual(['a', 'd'])
    expect(filterLeads(deals, { ...ALL, pipelineId: 'p2' }).map((d) => d.id)).toEqual(['b'])
    expect(filterLeads(deals, { ...ALL, reason: 'price' }).map((d) => d.id)).toEqual(['b'])
    expect(filterLeads(deals, { ...ALL, query: 'sol' }).map((d) => d.id)).toEqual(['c'])
  })

  it('filters by closed day and leaves open deals out of a closed range', () => {
    const range = { from: '2026-10-01', to: '2026-10-31' }
    expect(filterLeads(deals, { ...ALL, dateField: 'closed', range }).map((d) => d.id)).toEqual(['a', 'd'])
    expect(filterLeads(deals, { ...ALL, dateField: 'created', range }).map((d) => d.id)).toEqual(['a', 'b', 'd'])
  })

  it('uses business-local days (a 01:00 UTC creation is the previous day)', () => {
    const late = deal({ id: 'late', created_at: '2026-10-01T01:00:00Z' })
    const range = { from: '2026-09-30', to: '2026-09-30' }
    expect(filterLeads([late], { ...ALL, range })).toHaveLength(1)
  })

  it('summarizes counts, close rate and won value per currency', () => {
    const s = summarizeLeads(deals, 'USD')
    expect(s).toMatchObject({ total: 4, open: 1, won: 2, lost: 1, winRate: 67 })
    expect(s.wonValue).toEqual({ USD: 100, DOP: 50 })
  })

  it('builds the date presets from today', () => {
    const custom = { from: '2026-10-09', to: '2026-10-01' }
    expect(rangeFor('lastMonth', custom, '2026-10-08')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(rangeFor('custom', custom, '2026-10-08')).toEqual({ from: '2026-10-01', to: '2026-10-09' })
    expect(rangeFor('all', custom, '2026-10-08')).toBeNull()
  })

  it('exports quoted CSV with a BOM', () => {
    const csv = leadsToCsv([deal({ title: 'A, "B"', contact: { name: 'Ana' } as LeadDeal['contact'] })], {
      headers: ['h1'],
      pipelineName: () => 'P',
      stageName: () => 'S',
      statusLabel: (s) => s,
      reasonLabel: () => '',
      sourceLabel: () => '',
    })
    expect(csv.startsWith('﻿h1\r\n')).toBe(true)
    expect(csv).toContain('"A, ""B"""')
  })
})

describe('lead form submissions', () => {
  it('recognizes a missing table', () => {
    expect(isMissingTableError({ code: '42P01' })).toBe(true)
    expect(isMissingTableError({ code: 'PGRST205', message: 'not in the schema cache' })).toBe(true)
    expect(isMissingTableError({ code: '23505', message: 'duplicate key' })).toBe(false)
  })

  it('keeps a bounded copy of the raw fields', () => {
    const raw = rawSubmissionFields({ a: 'x'.repeat(5000), b: 3, c: { nested: true } })
    expect((raw.a as string).length).toBe(4000)
    expect(raw.b).toBe(3)
    expect(raw.c).toEqual({ nested: true })
  })
})
