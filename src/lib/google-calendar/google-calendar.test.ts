import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { signState, verifyState } from './oauth'
import { oauthResult } from './popup'
import { bookingToEvent, eventsToBusy } from './sync'

describe('OAuth state', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-secret')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('round-trips the account and user', () => {
    const now = Date.now()
    expect(verifyState(signState('acc', 'user', now), now)).toEqual({ accountId: 'acc', userId: 'user' })
  })

  it('rejects tampered, expired or missing state', () => {
    const now = Date.now()
    const state = signState('acc', 'user', now)
    const [payload, mac] = state.split('.')
    const forged = Buffer.from(JSON.stringify({ a: 'other', u: 'user', t: now })).toString('base64url')
    expect(verifyState(`${forged}.${mac}`, now)).toBeNull()
    expect(verifyState(`${payload}.${mac.slice(0, -2)}xx`, now)).toBeNull()
    expect(verifyState(state, now + 16 * 60_000)).toBeNull()
    expect(verifyState(null, now)).toBeNull()
  })

  it('remembers a popup flow', () => {
    const now = Date.now()
    expect(verifyState(signState('acc', 'user', now, true), now)).toEqual({ accountId: 'acc', userId: 'user', popup: true })
  })
})

describe('oauthResult', () => {
  it('redirects a full-page flow back to the agenda', () => {
    const res = oauthResult('https://crm.example', 'connected', false)
    expect(res.headers.get('location')).toBe('https://crm.example/agenda?google=connected')
  })

  it('answers a popup flow with a page that notifies the CRM and closes', async () => {
    const res = oauthResult('https://crm.example', 'denied', true)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    expect(html).toContain('"status":"denied"')
    expect(html).toContain('postMessage(msg, "https://crm.example")')
    expect(html).toContain('BroadcastChannel("wacrm-google-calendar")')
    expect(html).toContain('window.close()')
    expect(html).toContain('/agenda?google=denied')
  })
})

describe('eventsToBusy', () => {
  it('keeps busy events and skips free, cancelled and CRM events', () => {
    const busy = eventsToBusy([
      { id: '1', start: { dateTime: '2026-10-06T10:00:00-04:00' }, end: { dateTime: '2026-10-06T11:00:00-04:00' } },
      {
        id: '2',
        transparency: 'transparent',
        start: { dateTime: '2026-10-06T12:00:00-04:00' },
        end: { dateTime: '2026-10-06T13:00:00-04:00' },
      },
      {
        id: '3',
        status: 'cancelled',
        start: { dateTime: '2026-10-06T12:00:00-04:00' },
        end: { dateTime: '2026-10-06T13:00:00-04:00' },
      },
      {
        id: '4',
        extendedProperties: { private: { wacrmBookingId: 'b1' } },
        start: { dateTime: '2026-10-06T14:00:00-04:00' },
        end: { dateTime: '2026-10-06T15:00:00-04:00' },
      },
      // All-day event: the whole business-local day.
      { id: '5', start: { date: '2026-10-07' }, end: { date: '2026-10-08' } },
    ])
    expect(busy).toEqual([
      { start: Date.parse('2026-10-06T14:00:00Z'), end: Date.parse('2026-10-06T15:00:00Z') },
      { start: Date.parse('2026-10-07T04:00:00Z'), end: Date.parse('2026-10-08T04:00:00Z') },
    ])
  })
})

describe('bookingToEvent', () => {
  it('describes the booking with its reference and tags it as ours', () => {
    const id = 'abcdef12-0000-0000-0000-000000000000'
    const event = bookingToEvent({
      id,
      account_id: 'acc',
      service: 'Consulta',
      starts_at: '2026-10-06T14:00:00Z',
      ends_at: '2026-10-06T15:00:00Z',
      status: 'confirmed',
      notes: null,
      created_by: null,
      customer_name: 'Ana Pérez',
      customer_phone: '8095551234',
      google_event_id: null,
      contact: null,
    })
    expect(event.summary).toBe('Consulta — Ana Pérez')
    expect(event.description).toContain('CITA-ABCDEF')
    expect(event.description).toContain('Agendada por la IA')
    expect(event.start).toEqual({ dateTime: '2026-10-06T14:00:00Z', timeZone: 'America/Santo_Domingo' })
    expect(event.extendedProperties.private.wacrmBookingId).toBe(id)
  })
})
