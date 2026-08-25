import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError } from '@/lib/auth/account'

let queryResult: { data: unknown; error: unknown } = { data: [], error: null }
const insertedPayloads: Record<string, unknown>[] = []

function fakeSupabase() {
  return {
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = vi.fn(chain)
      b.order = vi.fn(chain)
      b.eq = vi.fn(chain)
      b.insert = vi.fn((payload: Record<string, unknown>) => {
        insertedPayloads.push(payload)
        return b
      })
      b.single = vi.fn(() => Promise.resolve(queryResult))
      b.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(queryResult).then(resolve, reject)
      return b
    },
  }
}

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return {
    ...actual,
    getCurrentAccount: vi.fn(async () => ({ supabase: fakeSupabase(), accountId: 'acct-1', userId: 'user-1' })),
    requireRole: vi.fn(async () => ({ supabase: fakeSupabase(), accountId: 'acct-1', userId: 'user-1' })),
  }
})

import { GET, POST } from './route'
import { getCurrentAccount, requireRole } from '@/lib/auth/account'

function post(body: unknown) {
  return POST(new Request('http://localhost/api/bookings/reminder-rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('GET /api/bookings/reminder-rules', () => {
  beforeEach(() => {
    queryResult = { data: [{ id: 'r1', offset_minutes: 1440 }], error: null }
    ;(getCurrentAccount as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      supabase: fakeSupabase(),
      accountId: 'acct-1',
      userId: 'user-1',
    }))
  })
  afterEach(() => vi.clearAllMocks())

  it('returns the account-scoped rules', async () => {
    const res = await GET()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ rules: [{ id: 'r1', offset_minutes: 1440 }] })
  })

  it('returns 500 on a DB error', async () => {
    queryResult = { data: null, error: new Error('boom') }
    const res = await GET()
    expect(res.status).toBe(500)
  })
})

describe('POST /api/bookings/reminder-rules', () => {
  beforeEach(() => {
    insertedPayloads.length = 0
    queryResult = { data: { id: 'r1', offset_minutes: 1440, message_text: 'Hola {{contact_name}}' }, error: null }
    ;(requireRole as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      supabase: fakeSupabase(),
      accountId: 'acct-1',
      userId: 'user-1',
    }))
  })
  afterEach(() => vi.clearAllMocks())

  it('propagates the auth error when the caller lacks admin', async () => {
    ;(requireRole as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ForbiddenError())
    const res = await post({ offset_minutes: 1440, message_text: 'x' })
    expect(res.status).toBe(403)
    expect(insertedPayloads).toHaveLength(0)
  })

  it('400s on invalid JSON', async () => {
    const res = await POST(new Request('http://localhost/api/bookings/reminder-rules', {
      method: 'POST',
      body: '{not json',
    }))
    expect(res.status).toBe(400)
  })

  it('400s when offset_minutes is missing or non-positive', async () => {
    const res = await post({ offset_minutes: 0, message_text: 'x' })
    expect(res.status).toBe(400)
  })

  it('400s when message_text is blank', async () => {
    const res = await post({ offset_minutes: 60, message_text: '   ' })
    expect(res.status).toBe(400)
  })

  it('creates the rule scoped to the caller account', async () => {
    const res = await post({
      offset_minutes: 1440,
      message_text: 'Hola {{contact_name}}, te esperamos para {{service}}',
      template_name: 'reminder_24h',
      template_language: 'es_MX',
      enabled: true,
    })
    expect(res.status).toBe(201)
    expect(insertedPayloads).toEqual([
      {
        account_id: 'acct-1',
        offset_minutes: 1440,
        message_text: 'Hola {{contact_name}}, te esperamos para {{service}}',
        template_name: 'reminder_24h',
        template_language: 'es_MX',
        enabled: true,
      },
    ])
  })
})
