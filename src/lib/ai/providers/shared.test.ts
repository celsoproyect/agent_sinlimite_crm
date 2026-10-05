import { describe, it, expect, vi } from 'vitest'
import {
  parseAvailabilityArgs,
  slotButtonTitle,
  isAiBookingSlotReply,
  parseBookAppointment,
  parseNote,
  parseCustomField,
  parseLeadStage,
  parseSentiment,
  runBookAppointment,
} from './shared'

describe('parseNote', () => {
  it('accepts a short trimmed note', () => {
    expect(parseNote({ text: '  Likes the blue variant  ' })).toEqual({
      text: 'Likes the blue variant',
    })
  })

  it('rejects a missing/empty text', () => {
    expect(parseNote({})).toEqual({ error: 'text is required.' })
    expect(parseNote({ text: '   ' })).toEqual({ error: 'text is required.' })
  })

  it('rejects a note over 1000 characters', () => {
    const result = parseNote({ text: 'x'.repeat(1001) })
    expect(result).toEqual({ error: 'text must be 1000 characters or fewer.' })
  })
})

describe('parseCustomField', () => {
  const allowed = ['Budget', 'Preferred contact time']

  it('accepts a known field with a value', () => {
    expect(parseCustomField({ field: 'Budget', value: '$500' }, allowed)).toEqual({
      field: 'Budget',
      value: '$500',
    })
  })

  it('rejects a field not in the allowed list', () => {
    const result = parseCustomField({ field: 'Not A Field', value: 'x' }, allowed)
    expect(result).toEqual({
      error: 'field must be one of: Budget, Preferred contact time.',
    })
  })

  it('rejects a missing value', () => {
    expect(parseCustomField({ field: 'Budget', value: '' }, allowed)).toEqual({
      error: 'value is required.',
    })
  })

  it('rejects a value over 500 characters', () => {
    const result = parseCustomField({ field: 'Budget', value: 'x'.repeat(501) }, allowed)
    expect(result).toEqual({ error: 'value must be 500 characters or fewer.' })
  })
})

describe('parseLeadStage', () => {
  const allowed = ['New', 'Qualified', 'Won']

  it('accepts a known stage', () => {
    expect(parseLeadStage({ stage: 'Qualified' }, allowed)).toEqual({ stage: 'Qualified' })
  })

  it('rejects an unknown stage', () => {
    expect(parseLeadStage({ stage: 'Nope' }, allowed)).toEqual({
      error: 'stage must be one of: New, Qualified, Won.',
    })
  })

  it('rejects a missing stage', () => {
    expect(parseLeadStage({}, allowed)).toEqual({
      error: 'stage must be one of: New, Qualified, Won.',
    })
  })
})

describe('parseSentiment', () => {
  it('accepts each valid sentiment', () => {
    expect(parseSentiment({ sentiment: 'positive' })).toEqual({ sentiment: 'positive' })
    expect(parseSentiment({ sentiment: 'neutral' })).toEqual({ sentiment: 'neutral' })
    expect(parseSentiment({ sentiment: 'negative' })).toEqual({ sentiment: 'negative' })
  })

  it('rejects an invalid sentiment', () => {
    expect(parseSentiment({ sentiment: 'furious' })).toEqual({
      error: 'sentiment must be one of: positive, neutral, negative.',
    })
  })

  it('rejects a missing sentiment', () => {
    expect(parseSentiment({})).toEqual({
      error: 'sentiment must be one of: positive, neutral, negative.',
    })
  })
})

describe('isAiBookingSlotReply', () => {
  it('recognises the offered-slot buttons the AI itself sent', () => {
    expect(isAiBookingSlotReply('booking_slot_0')).toBe(true)
    expect(isAiBookingSlotReply('booking_slot_2')).toBe(true)
  })

  it('leaves every other interactive reply to the Flows engine', () => {
    expect(isAiBookingSlotReply('flow_yes')).toBe(false)
    expect(isAiBookingSlotReply(null)).toBe(false)
    expect(isAiBookingSlotReply(undefined)).toBe(false)
  })
})

describe('parseBookAppointment', () => {
  it('passes a zoned timestamp through as UTC', () => {
    expect(
      parseBookAppointment({
        startsAt: '2026-09-08T13:00:00.000Z',
        endsAt: '2026-09-08T14:00:00.000Z',
        service: 'Corte',
      }),
    ).toEqual({
      appointment: {
        startsAt: '2026-09-08T13:00:00.000Z',
        endsAt: '2026-09-08T14:00:00.000Z',
        service: 'Corte',
        notes: undefined,
      },
    })
  })

  // The model reconstructs a timestamp from the wall-clock time it quoted
  // the customer whenever it no longer has check_availability's ISO
  // values in context. That bare form is business-local, and used to be
  // parsed against the host's zone instead.
  it('anchors a zone-less timestamp to the business timezone', () => {
    const result = parseBookAppointment({
      startsAt: '2026-09-08T09:00:00',
      endsAt: '2026-09-08T10:00:00',
      service: 'Corte',
    })
    expect(result).toEqual({
      appointment: {
        startsAt: '2026-09-08T13:00:00.000Z',
        endsAt: '2026-09-08T14:00:00.000Z',
        service: 'Corte',
        notes: undefined,
      },
    })
  })

  it('rejects incomplete or backwards arguments', () => {
    expect(parseBookAppointment({ endsAt: '2026-09-08T14:00:00Z', service: 'x' })).toEqual({
      error: 'startsAt is required and must be a valid ISO timestamp.',
    })
    expect(
      parseBookAppointment({
        startsAt: '2026-09-08T14:00:00Z',
        endsAt: '2026-09-08T13:00:00Z',
        service: 'x',
      }),
    ).toEqual({ error: 'endsAt must be after startsAt.' })
  })
})

describe('runBookAppointment', () => {
  const ARGS = {
    startsAt: '2026-09-08T13:00:00.000Z',
    endsAt: '2026-09-08T14:00:00.000Z',
    service: 'Corte',
  }
  const execute = async () => ({ slots: [] })

  it('reports a refusal from the writer and keeps the appointment unset', async () => {
    const create = vi.fn().mockResolvedValue({ confirmed: false, error: 'that time is already taken' })
    const result = await runBookAppointment({ execute, create }, ARGS)
    expect(create).toHaveBeenCalledOnce()
    expect(JSON.parse(result.resultJson)).toEqual({
      confirmed: false,
      error: 'that time is already taken',
    })
    expect(result.appointment).toBeUndefined()
  })

  it('reports success and hands back the written appointment', async () => {
    const create = vi.fn().mockResolvedValue({ confirmed: true })
    const result = await runBookAppointment({ execute, create }, ARGS)
    expect(JSON.parse(result.resultJson)).toEqual({ confirmed: true })
    expect(result.appointment).toMatchObject({ startsAt: ARGS.startsAt, service: 'Corte' })
  })

  it('turns a throwing writer into an honest refusal instead of a crash', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const create = vi.fn().mockRejectedValue(new Error('boom'))
    const result = await runBookAppointment({ execute, create }, ARGS)
    expect(JSON.parse(result.resultJson)).toEqual({
      confirmed: false,
      error: 'the booking could not be saved',
    })
    expect(result.appointment).toBeUndefined()
    vi.restoreAllMocks()
  })

  it('acknowledges without writing when no writer is wired up (Playground)', async () => {
    const result = await runBookAppointment({ execute }, ARGS)
    expect(JSON.parse(result.resultJson)).toEqual({ confirmed: true })
    expect(result.appointment).toMatchObject({ service: 'Corte' })
  })
})

describe('parseAvailabilityArgs', () => {
  it('normalizes the optional time and drops garbage', () => {
    expect(parseAvailabilityArgs({ date: '2026-09-08', time: '9:30' })).toEqual({ date: '2026-09-08', time: '09:30' })
    expect(parseAvailabilityArgs({ date: '2026-09-08', time: '8pm' })).toEqual({ date: '2026-09-08', time: undefined })
    expect(parseAvailabilityArgs(undefined)).toEqual({ date: '', time: undefined })
  })
})

describe('slotButtonTitle', () => {
  const mon9 = { startsAt: '2026-09-14T13:00:00.000Z', endsAt: '2026-09-14T14:00:00.000Z' }
  const mon10 = { startsAt: '2026-09-14T14:00:00.000Z', endsAt: '2026-09-14T15:00:00.000Z' }
  const tue9 = { startsAt: '2026-09-15T13:00:00.000Z', endsAt: '2026-09-15T14:00:00.000Z' }

  it('shows just the time when every slot is on the same day', () => {
    expect(slotButtonTitle(mon9, [mon9, mon10])).toBe('09:00')
  })

  it('prefixes day/month when the slots span several days', () => {
    expect(slotButtonTitle(tue9, [mon9, mon10, tue9])).toBe('15/09 09:00')
  })
})

describe('parseLeadStage — deal amount', () => {
  it('keeps a valid amount and currency, and tolerates thousands separators', () => {
    expect(parseLeadStage({ stage: 'Qualified', value: '3,500', currency: 'dop' }, ['Qualified'])).toEqual({
      stage: 'Qualified',
      value: { amount: 3500, currency: 'DOP' },
    })
  })

  it('ignores a missing or bogus amount without failing the stage', () => {
    expect(parseLeadStage({ stage: 'Qualified', value: 'n/a' }, ['Qualified'])).toEqual({ stage: 'Qualified' })
  })
})
