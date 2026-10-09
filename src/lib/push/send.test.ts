import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendNotification = vi.fn()
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: (...a: unknown[]) => sendNotification(...a) },
}))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => null }))
const moduleOn = vi.fn(async () => true)
vi.mock('@/lib/modules-server', () => ({ accountModuleEnabled: () => moduleOn() }))

import { sendPushToUsers, trimPushBody } from './send'

/** Minimal chainable Supabase stub recording deletes/updates. */
function fakeDb(rows: Array<{ id: string; endpoint: string; p256dh: string; auth: string }>) {
  const deleted: string[][] = []
  const updated: string[][] = []
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({ in: async () => ({ data: rows, error: null }) }),
      }),
      delete: () => ({
        in: async (_c: string, ids: string[]) => {
          deleted.push(ids)
          return { error: null }
        },
      }),
      update: () => ({
        in: async (_c: string, ids: string[]) => {
          updated.push(ids)
          return { error: null }
        },
      }),
    }),
  }
  return { db: db as never, deleted, updated }
}

const payload = { title: 'Hola', body: 'Resumen', url: '/inbox?c=1' }

describe('sendPushToUsers', () => {
  beforeEach(() => {
    vi.stubEnv('VAPID_PUBLIC_KEY', 'pub')
    vi.stubEnv('VAPID_PRIVATE_KEY', 'priv')
    sendNotification.mockReset()
    moduleOn.mockResolvedValue(true)
  })
  afterEach(() => vi.unstubAllEnvs())

  it('is a no-op without VAPID keys', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '')
    const { db } = fakeDb([{ id: 's1', endpoint: 'https://x', p256dh: 'p', auth: 'a' }])
    expect(await sendPushToUsers('acc', ['u1'], payload, db)).toEqual({ sent: 0, failed: 0 })
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('is a no-op when the module is off', async () => {
    moduleOn.mockResolvedValue(false)
    const { db } = fakeDb([{ id: 's1', endpoint: 'https://x', p256dh: 'p', auth: 'a' }])
    expect(await sendPushToUsers('acc', ['u1'], payload, db)).toEqual({ sent: 0, failed: 0 })
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('sends to every device and deletes the gone ones', async () => {
    sendNotification
      .mockResolvedValueOnce({ statusCode: 201 })
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { statusCode: 500 }))
    const { db, deleted, updated } = fakeDb([
      { id: 's1', endpoint: 'https://a', p256dh: 'p', auth: 'a' },
      { id: 's2', endpoint: 'https://b', p256dh: 'p', auth: 'a' },
      { id: 's3', endpoint: 'https://c', p256dh: 'p', auth: 'a' },
    ])
    const result = await sendPushToUsers('acc', ['u1'], payload, db)
    expect(result).toEqual({ sent: 1, failed: 2 })
    expect(JSON.parse(sendNotification.mock.calls[0][1])).toEqual(payload)
    expect(deleted).toEqual([['s2']])
    expect(updated).toEqual([['s1']])
  })
})

describe('trimPushBody', () => {
  it('keeps short text and trims long text on a word boundary', () => {
    expect(trimPushBody('  hola   mundo ')).toBe('hola mundo')
    const long = 'palabra '.repeat(40)
    const trimmed = trimPushBody(long, 50)
    expect(trimmed.length).toBeLessThanOrEqual(50)
    expect(trimmed.endsWith('palabra…')).toBe(true)
  })
})
