import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForbiddenError } from '@/lib/auth/account'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

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
      b.maybeSingle = vi.fn(() => Promise.resolve(queryResult))
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

import { PATCH } from './route'
import { requireRole } from '@/lib/auth/account'

function patch(id: string, body: unknown) {
  return PATCH(
    new Request(`http://localhost/api/ai/attachments/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

const UPDATED_ROW = {
  id: VALID_ID,
  name: 'Item',
  description: 'Desc',
  kind: 'image',
  media_url: 'https://example.com/new.png',
  filename: 'new.png',
  mime_type: 'image/png',
  price: null,
  currency: null,
  updated_at: '2026-01-01T00:00:00Z',
}

beforeEach(() => {
  __resetRateLimitForTests()
  updatedPayloads.length = 0
  queryResult = { data: UPDATED_ROW, error: null }
  ;(requireRole as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
    supabase: fakeSupabase(),
    accountId: 'acct-1',
    userId: 'user-1',
  }))
})
afterEach(() => vi.clearAllMocks())

describe('PATCH /api/ai/attachments/[id]', () => {
  it('propagates the auth error when the caller lacks admin', async () => {
    ;(requireRole as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ForbiddenError())
    const res = await patch(VALID_ID, { name: 'x' })
    expect(res.status).toBe(403)
  })

  it('400s when no fields are supplied', async () => {
    const res = await patch(VALID_ID, {})
    expect(res.status).toBe(400)
  })

  it('400s when a partial set of file fields is supplied', async () => {
    const res = await patch(VALID_ID, { mediaUrl: 'https://example.com/new.png' })
    expect(res.status).toBe(400)
    expect(updatedPayloads).toEqual([])
  })

  it('updates name/description only, leaving the file untouched', async () => {
    const res = await patch(VALID_ID, { name: 'New name', description: 'New desc' })
    expect(res.status).toBe(200)
    expect(updatedPayloads).toEqual([{ name: 'New name', description: 'New desc' }])
  })

  it('replaces the file when all four file fields are supplied together', async () => {
    const res = await patch(VALID_ID, {
      kind: 'image',
      mediaUrl: 'https://example.com/new.png',
      filename: 'new.png',
      mimeType: 'image/png',
    })
    expect(res.status).toBe(200)
    expect(updatedPayloads).toEqual([
      {
        kind: 'image',
        media_url: 'https://example.com/new.png',
        filename: 'new.png',
        mime_type: 'image/png',
      },
    ])
    const json = await res.json()
    expect(json.attachment.mediaUrl).toBe('https://example.com/new.png')
  })

  it('404s when the row does not belong to this account', async () => {
    queryResult = { data: null, error: null }
    const res = await patch(VALID_ID, { name: 'New name' })
    expect(res.status).toBe(404)
  })
})
