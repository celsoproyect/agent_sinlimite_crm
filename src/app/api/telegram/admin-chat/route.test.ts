import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ForbiddenError } from '@/lib/auth/account'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

let accountRow: Record<string, unknown> | null = {
  telegram_bot_token: 'tok-1',
  telegram_chat_id: 'chat-1',
}
const updatePayloads: Record<string, unknown>[] = []

function fakeSupabase() {
  return {
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = vi.fn(chain)
      b.eq = vi.fn(chain)
      b.single = vi.fn(() => Promise.resolve({ data: accountRow, error: accountRow ? null : new Error('no row') }))
      b.update = vi.fn((payload: Record<string, unknown>) => {
        updatePayloads.push(payload)
        return { eq: vi.fn(() => Promise.resolve({ error: null })) }
      })
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

const { setTelegramWebhook, deleteTelegramWebhook } = vi.hoisted(() => ({
  setTelegramWebhook: vi.fn(async () => undefined),
  deleteTelegramWebhook: vi.fn(async () => undefined),
}))
vi.mock('@/lib/telegram/send', () => ({ setTelegramWebhook, deleteTelegramWebhook }))

import { POST, DELETE } from './route'
import { requireRole } from '@/lib/auth/account'

describe('POST /api/telegram/admin-chat', () => {
  beforeEach(() => {
    __resetRateLimitForTests()
    accountRow = { telegram_bot_token: 'tok-1', telegram_chat_id: 'chat-1' }
    updatePayloads.length = 0
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.com'
    setTelegramWebhook.mockClear().mockResolvedValue(undefined)
    deleteTelegramWebhook.mockClear().mockResolvedValue(undefined)
    ;(requireRole as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      supabase: fakeSupabase(),
      accountId: 'acct-1',
      userId: 'user-1',
    }))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('propagates the auth error when the caller lacks admin', async () => {
    ;(requireRole as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ForbiddenError())
    const res = await POST()
    expect(res.status).toBe(403)
    expect(setTelegramWebhook).not.toHaveBeenCalled()
  })

  it('400s when there is no saved bot token or chat id', async () => {
    accountRow = { telegram_bot_token: null, telegram_chat_id: null }
    const res = await POST()
    expect(res.status).toBe(400)
    expect(setTelegramWebhook).not.toHaveBeenCalled()
  })

  it('registers the webhook with a fresh secret and enables the toggle', async () => {
    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(setTelegramWebhook).toHaveBeenCalledWith({
      botToken: 'tok-1',
      url: 'https://app.example.com/api/telegram/webhook/acct-1',
      secretToken: expect.any(String),
    })
    expect(updatePayloads).toEqual([
      { telegram_admin_chat_enabled: true, telegram_webhook_secret: expect.any(String) },
    ])
    expect((updatePayloads[0].telegram_webhook_secret as string)).toHaveLength(64)
  })

  it('maps a Telegram setWebhook failure to a 502 without enabling the toggle', async () => {
    setTelegramWebhook.mockRejectedValueOnce(new Error('Telegram API error: 400'))
    const res = await POST()
    expect(res.status).toBe(502)
    expect(updatePayloads).toHaveLength(0)
  })
})

describe('DELETE /api/telegram/admin-chat', () => {
  beforeEach(() => {
    __resetRateLimitForTests()
    accountRow = { telegram_bot_token: 'tok-1', telegram_chat_id: 'chat-1' }
    updatePayloads.length = 0
    setTelegramWebhook.mockClear().mockResolvedValue(undefined)
    deleteTelegramWebhook.mockClear().mockResolvedValue(undefined)
    ;(requireRole as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      supabase: fakeSupabase(),
      accountId: 'acct-1',
      userId: 'user-1',
    }))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('propagates the auth error when the caller lacks admin', async () => {
    ;(requireRole as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ForbiddenError())
    const res = await DELETE()
    expect(res.status).toBe(403)
    expect(deleteTelegramWebhook).not.toHaveBeenCalled()
  })

  it('calls deleteWebhook and disables the toggle', async () => {
    const res = await DELETE()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(deleteTelegramWebhook).toHaveBeenCalledWith('tok-1')
    expect(updatePayloads).toEqual([{ telegram_admin_chat_enabled: false, telegram_webhook_secret: null }])
  })

  it('still disables the toggle locally even if deleteWebhook fails', async () => {
    deleteTelegramWebhook.mockRejectedValueOnce(new Error('Telegram API error: 400'))
    const res = await DELETE()
    expect(res.status).toBe(200)
    expect(updatePayloads).toEqual([{ telegram_admin_chat_enabled: false, telegram_webhook_secret: null }])
  })
})
