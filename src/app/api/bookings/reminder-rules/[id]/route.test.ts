import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError } from '@/lib/auth/account'

const VALID_ID = '11111111-1111-1111-1111-111111111111'

let queryResult: { data: unknown; error: unknown } = { data: null, error: null }
const updatedPayloads: Record<string, unknown>[] = []

function fakeSupabase() {
  return {
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = vi.fn(chain)
      b.eq = vi.fn(chain)
      b.delete = vi.fn(chain)
      b.update = vi.fn((payload: Record<string, unknown>) => {
        updatedPayloads.push(payload)
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
    requireRole: vi.fn(async () => ({ supabase: fakeSupabase(), accountId: 'acct-1', userId: 'user-1' })),
  }
})

import { PATCH, DELETE } from './route'
import { requireRole } from '@/lib/auth/account'

function patch(id: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/bookings/reminder-rules/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

function del(id: string) {
  return DELETE(
    new Request(`http://localhost/api/bookings/reminder-rules/${id}`, { method: 'DELETE' }),
    { params: Promise.resolve({ id }) },
  )
}

beforeEach(() => {
  updatedPayloads.length = 0
  queryResult = { data: { id: VALID_ID, offset_minutes: 60 }, error: null }
  ;(requireRole as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
    supabase: fakeSupabase(),
    accountId: 'acct-1',
    userId: 'user-1',
  }))
})
afterEach(() => vi.clearAllMocks())

describe('PATCH /api/bookings/reminder-rules/[id]', () => {
  it('400s on a malformed id', async () => {
    const res = await patch('not-a-uuid', { enabled: false })
    expect(res.status).toBe(400)
  })

  it('propagates the auth error when the caller lacks admin', async () => {
    ;(requireRole as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ForbiddenError())
    const res = await patch(VALID_ID, { enabled: false })
    expect(res.status).toBe(403)
  })

  it('400s when no fields are supplied', async () => {
    const res = await patch(VALID_ID, {})
    expect(res.status).toBe(400)
  })

  it('400s when message_text is blank', async () => {
    const res = await patch(VALID_ID, { message_text: '   ' })
    expect(res.status).toBe(400)
  })

  it('updates the rule', async () => {
    const res = await patch(VALID_ID, { enabled: false, template_name: null })
    expect(res.status).toBe(200)
    expect(updatedPayloads).toEqual([{ enabled: false, template_name: null }])
  })
})

describe('DELETE /api/bookings/reminder-rules/[id]', () => {
  it('400s on a malformed id', async () => {
    const res = await del('not-a-uuid')
    expect(res.status).toBe(400)
  })

  it('propagates the auth error when the caller lacks admin', async () => {
    ;(requireRole as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ForbiddenError())
    const res = await del(VALID_ID)
    expect(res.status).toBe(403)
  })

  it('deletes the rule', async () => {
    queryResult = { data: null, error: null }
    const res = await del(VALID_ID)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ ok: true })
  })
})
