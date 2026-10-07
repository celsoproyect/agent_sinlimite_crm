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
  runManageAppointmentTool,
  bookingToolDefinitions,
  runBookingTool,
  offerToToolResult,
  type BookingManageTool,
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
        customerName: 'Ana Pérez',
        customerPhone: '809-555-1234',
      }),
    ).toEqual({
      appointment: {
        startsAt: '2026-09-08T13:00:00.000Z',
        endsAt: '2026-09-08T14:00:00.000Z',
        service: 'Corte',
        notes: undefined,
        customerName: 'Ana Pérez',
        customerPhone: '809-555-1234',
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
      customerName: 'Ana Pérez',
      customerPhone: '809-555-1234',
    })
    expect(result).toEqual({
      appointment: {
        startsAt: '2026-09-08T13:00:00.000Z',
        endsAt: '2026-09-08T14:00:00.000Z',
        service: 'Corte',
        notes: undefined,
        customerName: 'Ana Pérez',
        customerPhone: '809-555-1234',
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

  it('requires the customer name and a real phone number', () => {
    const base = { startsAt: '2026-09-08T13:00:00Z', endsAt: '2026-09-08T14:00:00Z', service: 'Corte' }
    expect(parseBookAppointment({ ...base, customerPhone: '8095551234' })).toEqual({
      error: 'customerName is required: ask the customer for their full name before booking.',
    })
    expect(parseBookAppointment({ ...base, customerName: 'Ana', customerPhone: '123' })).toEqual({
      error: 'customerPhone is required: ask the customer for their phone number before booking.',
    })
  })
})

describe('runBookAppointment', () => {
  const ARGS = {
    startsAt: '2026-09-08T13:00:00.000Z',
    endsAt: '2026-09-08T14:00:00.000Z',
    service: 'Corte',
    customerName: 'Ana Pérez',
    customerPhone: '8095551234',
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
    const create = vi.fn().mockResolvedValue({ confirmed: true, reference: 'CITA-3F9A2C' })
    const result = await runBookAppointment({ execute, create }, ARGS)
    expect(JSON.parse(result.resultJson)).toEqual({ confirmed: true, reference: 'CITA-3F9A2C' })
    expect(result.appointment).toMatchObject({
      startsAt: ARGS.startsAt,
      service: 'Corte',
      customerPhone: '8095551234',
      reference: 'CITA-3F9A2C',
    })
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

describe('runManageAppointmentTool', () => {
  const found = [
    {
      reference: 'CITA-3F9A2C',
      service: 'Corte',
      startsAt: '2026-09-08T13:00:00.000Z',
      endsAt: '2026-09-08T14:00:00.000Z',
      date: '2026-09-08',
      time: '09:00',
      customerName: 'Ana',
    },
  ]
  const makeTool = (): BookingManageTool => ({
    find: vi.fn().mockResolvedValue(found),
    reschedule: vi.fn().mockResolvedValue({
      rescheduled: true,
      appointment: {
        startsAt: '2026-09-09T14:00:00.000Z',
        endsAt: '2026-09-09T15:00:00.000Z',
        service: 'Corte',
        reference: 'CITA-3F9A2C',
      },
    }),
    cancel: vi.fn().mockResolvedValue({ cancelled: true, reference: 'CITA-3F9A2C' }),
  })

  it('ignores tools that are not its own', async () => {
    expect(await runManageAppointmentTool(makeTool(), 'book_appointment', {})).toBeNull()
  })

  it('asks for the phone before looking anything up', async () => {
    const tool = makeTool()
    const result = await runManageAppointmentTool(tool, 'find_appointments', { phone: '12' })
    expect(JSON.parse(result!.resultJson).error).toMatch(/phone is required/)
    expect(tool.find).not.toHaveBeenCalled()
  })

  it('lists the appointments found for a phone', async () => {
    const tool = makeTool()
    const result = await runManageAppointmentTool(tool, 'find_appointments', { phone: '+1 809 555 1234' })
    expect(tool.find).toHaveBeenCalledWith({ phone: '+1 809 555 1234' })
    expect(JSON.parse(result!.resultJson)).toEqual({ appointments: found })
  })

  it('moves the appointment and hands it back with its local time', async () => {
    const tool = makeTool()
    const result = await runManageAppointmentTool(tool, 'reschedule_appointment', {
      phone: '8095551234',
      reference: 'CITA-3F9A2C',
      startsAt: '2026-09-09T10:00:00',
      endsAt: '2026-09-09T11:00:00',
    })
    expect(tool.reschedule).toHaveBeenCalledWith({
      phone: '8095551234',
      reference: 'CITA-3F9A2C',
      startsAt: '2026-09-09T14:00:00.000Z',
      endsAt: '2026-09-09T15:00:00.000Z',
    })
    expect(JSON.parse(result!.resultJson)).toEqual({
      rescheduled: true,
      reference: 'CITA-3F9A2C',
      date: '2026-09-09',
      time: '10:00',
    })
    expect(result!.appointment?.reference).toBe('CITA-3F9A2C')
  })

  it('cancels by phone and reference', async () => {
    const tool = makeTool()
    const result = await runManageAppointmentTool(tool, 'cancel_appointment', {
      phone: '8095551234',
      reference: 'cita-3f9a2c',
    })
    expect(tool.cancel).toHaveBeenCalledWith({ phone: '8095551234', reference: 'cita-3f9a2c' })
    expect(JSON.parse(result!.resultJson)).toEqual({ cancelled: true, reference: 'CITA-3F9A2C' })
  })
})

describe('clinic module tools', () => {
  const slotAna = {
    startsAt: '2026-09-14T13:00:00.000Z',
    endsAt: '2026-09-14T14:00:00.000Z',
    professionalId: 'p1',
    professionalName: 'Dra. Ana Pérez',
  }
  const slotLuis = { ...slotAna, professionalId: 'p2', professionalName: 'Dr. Luis Gómez' }

  it('parses the doctor and specialty filters only when present', () => {
    expect(parseAvailabilityArgs({ date: '2026-09-08', professional_id: ' p1 ', specialty: '' })).toEqual({
      date: '2026-09-08',
      time: undefined,
      professionalId: 'p1',
    })
  })

  it('offers find_professionals and requires professional_id only in clinic mode', () => {
    const execute = async () => ({ slots: [] })
    const plain = bookingToolDefinitions({ execute })
    expect(plain.map((d) => d.name)).not.toContain('find_professionals')
    expect(plain.find((d) => d.name === 'book_appointment')?.parameters.required).not.toContain('professional_id')

    const clinic = bookingToolDefinitions({ execute, clinic: { find: async () => [] } })
    expect(clinic.map((d) => d.name)).toContain('find_professionals')
    expect(clinic.find((d) => d.name === 'book_appointment')?.parameters.required).toContain('professional_id')
  })

  it('offers service_id and a required insurance only when the clinic has them', () => {
    const execute = async () => ({ slots: [] })
    const basic = bookingToolDefinitions({ execute, clinic: { find: async () => [] } })
    const book = basic.find((d) => d.name === 'book_appointment')!
    expect(book.parameters.properties).not.toHaveProperty('service_id')
    expect(book.parameters.properties).not.toHaveProperty('insurance')

    const full = bookingToolDefinitions({ execute, clinic: { find: async () => [], services: true, insurance: true } })
    const fullBook = full.find((d) => d.name === 'book_appointment')!
    expect(fullBook.parameters.properties).toHaveProperty('service_id')
    expect(fullBook.parameters.required).toContain('insurance')
    expect(full.find((d) => d.name === 'check_availability')?.parameters.properties).toHaveProperty('service_id')
  })

  it('passes service_id to the availability lookup only when services exist', async () => {
    const execute = vi.fn().mockResolvedValue({ slots: [] })
    await runBookingTool({ execute, clinic: { find: async () => [], services: true } }, 'check_availability', { date: '2026-09-14', service_id: 'svc-1' }, {})
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'svc-1' }))

    execute.mockClear()
    await runBookingTool({ execute, clinic: { find: async () => [] } }, 'check_availability', { date: '2026-09-14', service_id: 'svc-1' }, {})
    expect(execute.mock.calls[0][0]).not.toHaveProperty('serviceId')
  })

  it('reads service_id and insurance from book_appointment', () => {
    const parsed = parseBookAppointment({
      startsAt: '2026-09-08T13:00:00.000Z',
      endsAt: '2026-09-08T14:00:00.000Z',
      service: 'Eco',
      customerName: 'Ana Pérez',
      customerPhone: '809-555-1234',
      service_id: 'svc-1',
      insurance: ' Humano, afiliado 123 ',
    })
    expect(parsed).toMatchObject({ appointment: { serviceId: 'svc-1', insurance: 'Humano, afiliado 123' } })
  })

  it('names the doctor on slot buttons when the offer spans several doctors', () => {
    expect(slotButtonTitle(slotAna, [slotAna, slotLuis])).toBe('09:00 Ana Pérez')
    expect(slotButtonTitle(slotAna, [slotAna])).toBe('09:00')
  })

  it('passes the filters to the availability lookup and tags each slot with its doctor', async () => {
    const execute = vi.fn().mockResolvedValue({ slots: [slotAna] })
    const outcome = {}
    const json = await runBookingTool(
      { execute, clinic: { find: async () => [] } },
      'check_availability',
      { date: '2026-09-14', specialty: 'Pediatría' },
      outcome,
    )
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-09-14', specialty: 'Pediatría' }))
    expect(json).toContain('"professional_id":"p1"')
    expect(json).toContain('Dra. Ana Pérez')
  })

  it('runs find_professionals and explains an empty result', async () => {
    const find = vi.fn().mockResolvedValue([])
    const json = await runBookingTool(
      { execute: async () => ({ slots: [] }), clinic: { find } },
      'find_professionals',
      { query: ' cardio ' },
      {},
    )
    expect(find).toHaveBeenCalledWith({ query: 'cardio' })
    expect(JSON.parse(json!)).toMatchObject({ professionals: [] })
    expect(JSON.parse(json!).note).toBeTruthy()

    // Not a booking tool outside clinic mode.
    expect(await runBookingTool({ execute: async () => ({ slots: [] }) }, 'find_professionals', {}, {})).toBeNull()
  })
})

describe('offerToToolResult — holidays', () => {
  it('tells the model the asked-for date is a holiday', () => {
    const json = JSON.parse(
      offerToToolResult({
        requested: { date: '2026-12-25', time: '10:00', available: false },
        holiday: { date: '2026-12-25', name: 'Navidad' },
        slots: [{ startsAt: '2026-12-26T14:00:00.000Z', endsAt: '2026-12-26T15:00:00.000Z' }],
      }),
    )
    expect(json.holiday.name).toBe('Navidad')
    expect(json.holiday.note).toContain('2026-12-25 (Navidad) is a holiday')
    expect(json.slots).toHaveLength(1)
  })

  it('adds nothing on an ordinary day', () => {
    const json = JSON.parse(offerToToolResult({ slots: [] }))
    expect(json.holiday).toBeUndefined()
  })
})
