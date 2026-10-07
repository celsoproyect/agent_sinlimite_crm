import { describe, expect, it } from 'vitest'
import { dayCount, MAX_REPORT_DAYS, parseReportRange, presetRange, previousRange, rangeInstants } from './range'
import { computeOverview, senderKind, type ReportMessage } from './overview'
import { durationParts, formatMoney } from './format'
import { sanitizeSearch } from './ai-messages'
import { buildWeeklySummaryText, weeklySummaryDue } from './weekly-summary'

// 2026-10-06 is a Tuesday.
const TUESDAY = '2026-10-06'

describe('report ranges', () => {
  it('builds the presets in business days', () => {
    expect(presetRange('today', TUESDAY)).toEqual({ from: TUESDAY, to: TUESDAY })
    expect(presetRange('yesterday', TUESDAY)).toEqual({ from: '2026-10-05', to: '2026-10-05' })
    expect(presetRange('week', TUESDAY)).toEqual({ from: '2026-10-05', to: TUESDAY })
    expect(presetRange('lastWeek', TUESDAY)).toEqual({ from: '2026-09-28', to: '2026-10-04' })
    expect(presetRange('month', TUESDAY)).toEqual({ from: '2026-10-01', to: TUESDAY })
    expect(presetRange('last30', TUESDAY)).toEqual({ from: '2026-09-07', to: TUESDAY })
  })

  it('bounds the range at Santo Domingo midnight (UTC-4)', () => {
    expect(rangeInstants({ from: TUESDAY, to: TUESDAY })).toEqual({
      fromISO: '2026-10-06T04:00:00.000Z',
      toISO: '2026-10-07T04:00:00.000Z',
    })
  })

  it('rejects bad input and caps long ranges', () => {
    const bad = parseReportRange('2026-10-09', '2026-10-01')
    expect(bad.from <= bad.to).toBe(true)
    const long = parseReportRange('2020-01-01', '2026-10-06')
    expect(long.to).toBe('2026-10-06')
    expect(dayCount(long)).toBe(MAX_REPORT_DAYS)
  })

  it('gives the same-length previous range', () => {
    expect(previousRange({ from: '2026-10-05', to: '2026-10-11' })).toEqual({ from: '2026-09-28', to: '2026-10-04' })
  })
})

describe('senderKind', () => {
  it('classifies messages', () => {
    expect(senderKind({ sender_type: 'customer', ai_generated: false, content_type: 'text' })).toBe('customer')
    expect(senderKind({ sender_type: 'bot', ai_generated: true, content_type: 'text' })).toBe('ai')
    expect(senderKind({ sender_type: 'agent', ai_generated: false, content_type: 'text' })).toBe('human')
    expect(senderKind({ sender_type: 'bot', ai_generated: false, content_type: 'text' })).toBe('automation')
    expect(senderKind({ sender_type: 'bot', ai_generated: true, content_type: 'system_event' })).toBe('system')
  })
})

describe('computeOverview', () => {
  const msg = (conversation_id: string, sender_type: string, created_at: string, ai = false): ReportMessage => ({
    conversation_id,
    sender_type,
    ai_generated: ai,
    content_type: 'text',
    created_at,
  })

  const overview = computeOverview({
    range: { from: TUESDAY, to: TUESDAY },
    channel: 'all',
    messages: [
      // The AI answers in 30 s.
      msg('a', 'customer', '2026-10-06T14:00:00.000Z'),
      msg('a', 'bot', '2026-10-06T14:00:30.000Z', true),
      // A person answers in 10 min.
      msg('b', 'customer', '2026-10-06T15:00:00.000Z'),
      msg('b', 'agent', '2026-10-06T15:10:00.000Z'),
      // Nobody answered.
      msg('c', 'customer', '2026-10-06T16:00:00.000Z'),
    ],
    newContactChannels: ['whatsapp', 'whatsapp', 'web'],
    wonDeals: [
      { value: 45000, currency: 'DOP', channel: 'whatsapp', aiAssisted: true },
      { value: 100, currency: 'usd', channel: 'web', aiAssisted: false },
    ],
    bookings: { total: 2, byAi: 1 },
  })

  it('counts conversations by who handled them', () => {
    expect(overview.conversations).toEqual({ total: 3, aiOnly: 1, withHuman: 1, unanswered: 1, aiRate: 50 })
    expect(overview.messages).toEqual({ customer: 3, ai: 1, human: 1, automation: 0 })
  })

  it('measures response times', () => {
    expect(overview.responseTime.ai).toEqual({ avgSeconds: 30, medianSeconds: 30, count: 1 })
    expect(overview.responseTime.human).toEqual({ avgSeconds: 600, medianSeconds: 600, count: 1 })
  })

  it('splits sales by channel and AI participation', () => {
    expect(overview.sales.won).toEqual({ count: 2, totals: { DOP: 45000, USD: 100 } })
    expect(overview.sales.aiAssisted).toEqual({ count: 1, totals: { DOP: 45000 } })
    expect(overview.sales.byChannel.web).toEqual({ count: 1, totals: { USD: 100 } })
    expect(overview.newContacts).toEqual({ total: 3, byChannel: { whatsapp: 2, web: 1 } })
  })

  it('builds the daily series in business days', () => {
    expect(overview.series).toEqual([{ date: TUESDAY, ai: 1, human: 1, customer: 3 }])
  })

  it('writes a weekly summary without phone numbers', () => {
    const text = buildWeeklySummaryText('Sin Limite IA', overview, overview)
    expect(text).toContain('Sin Limite IA')
    expect(text).toContain('DOP 45,000')
    expect(text).not.toMatch(/\d{3}-\d{3}-\d{4}/)
  })
})

describe('format', () => {
  it('formats money per currency', () => {
    expect(formatMoney({})).toBe('0')
    expect(formatMoney({ DOP: 45000, USD: 300 })).toBe('DOP 45,000 + USD 300')
  })

  it('picks a readable duration unit', () => {
    expect(durationParts(42)).toEqual({ value: '42', unit: 's' })
    expect(durationParts(95)).toEqual({ value: '2', unit: 'min' })
    expect(durationParts(5400)).toEqual({ value: '1.5', unit: 'h' })
    expect(durationParts(3 * 86400)).toEqual({ value: '3', unit: 'd' })
  })
})

describe('sanitizeSearch', () => {
  it('drops PostgREST filter characters', () => {
    expect(sanitizeSearch('  precio, (botox)*  ')).toBe('precio botox')
  })
})

describe('weeklySummaryDue', () => {
  // Monday 2026-10-05, 08:30 in Santo Domingo = 12:30Z.
  const mondayMorning = new Date('2026-10-05T12:30:00Z')

  it('is due on Monday from 8 AM business time', () => {
    expect(weeklySummaryDue(mondayMorning, null)).toBe(true)
    expect(weeklySummaryDue(new Date('2026-10-05T11:30:00Z'), null)).toBe(false)
    expect(weeklySummaryDue(new Date('2026-10-06T12:30:00Z'), null)).toBe(false)
  })

  it('is not due twice the same Monday', () => {
    expect(weeklySummaryDue(mondayMorning, '2026-10-05T12:15:00Z')).toBe(false)
    expect(weeklySummaryDue(mondayMorning, '2026-09-28T12:15:00Z')).toBe(true)
  })
})
