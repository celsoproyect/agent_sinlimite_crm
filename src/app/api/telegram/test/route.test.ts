import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ForbiddenError } from '@/lib/auth/account'

let accountRow: Record<string, unknown> | null = {
  telegram_bot_token: 'tok-1',
  telegram_chat_id: 'chat-1',
}

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return {
    ...actual,
    requireRole: vi.fn(async () => ({
      supabase: {
        from: () => {
          const b: Record<string, unknown> = {}
          const chain = () => b
          b.select = vi.fn(chain)
          b.eq = vi.fn(chain)
          b.single = vi.fn(() =>
            Promise.resolve({ data: accountRow, error: accountRow ? null : new Error('no row') }),
          )
          return b
        },
      },
      accountId: 'acct-1',
    })),
  }
})

const { sendTelegramMessage } = vi.hoisted(() => ({
  sendTelegramMessage: vi.fn(async () => undefined),
}))
vi.mock('@/lib/telegram/send', () => ({ sendTelegramMessage }))

import { POST } from './route'
import { requireRole } from '@/lib/auth/account'

describe('POST /api/telegram/test', () => {
  beforeEach(() => {
    accountRow = { telegram_bot_token: 'tok-1', telegram_chat_id: 'chat-1' }
    sendTelegramMessage.mockClear()
    ;(requireRole as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      supabase: {
        from: () => {
          const b: Record<string, unknown> = {}
          const chain = () => b
          b.select = vi.fn(chain)
          b.eq = vi.fn(chain)
          b.single = vi.fn(() =>
            Promise.resolve({ data: accountRow, error: accountRow ? null : new Error('no row') }),
          )
          return b
        },
      },
      accountId: 'acct-1',
    }))
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('propagates the auth error when the caller lacks admin', async () => {
    ;(requireRole as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ForbiddenError())

    const res = await POST()
    expect(res.status).toBe(403)
  })

  it('400s when the account has no saved bot token or chat id', async () => {
    accountRow = { telegram_bot_token: null, telegram_chat_id: null }

    const res = await POST()
    expect(res.status).toBe(400)
    expect(sendTelegramMessage).not.toHaveBeenCalled()
  })

  it('sends the fixed test message to the saved chat', async () => {
    const res = await POST()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(sendTelegramMessage).toHaveBeenCalledWith({
      botToken: 'tok-1',
      chatId: 'chat-1',
      text: expect.any(String),
    })
  })

  it('maps a Telegram send failure to a 502', async () => {
    sendTelegramMessage.mockRejectedValueOnce(new Error('Telegram API error: 400'))

    const res = await POST()
    expect(res.status).toBe(502)
  })
})
