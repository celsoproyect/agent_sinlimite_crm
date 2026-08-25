import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ForbiddenError } from '@/lib/auth/account'

let accountRow: Record<string, unknown> | null = { telegram_bot_token: 'tok-1' }
let requireRoleImpl: () => Promise<unknown> = async () => ({
  supabase: {
    from: () => {
      const b: Record<string, unknown> = {}
      const chain = () => b
      b.select = vi.fn(chain)
      b.eq = vi.fn(chain)
      b.single = vi.fn(() => Promise.resolve({ data: accountRow, error: accountRow ? null : new Error('no row') }))
      return b
    },
  },
  accountId: 'acct-1',
})

vi.mock('@/lib/auth/account', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/account')>('@/lib/auth/account')
  return {
    ...actual,
    requireRole: vi.fn(() => requireRoleImpl()),
  }
})

const { getLatestTelegramChat } = vi.hoisted(() => ({
  getLatestTelegramChat: vi.fn(),
}))
vi.mock('@/lib/telegram/send', () => ({ getLatestTelegramChat }))

import { POST } from './route'
import { requireRole } from '@/lib/auth/account'

describe('POST /api/telegram/detect-chat', () => {
  beforeEach(() => {
    accountRow = { telegram_bot_token: 'tok-1' }
    requireRoleImpl = async () => ({
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
    })
    getLatestTelegramChat.mockReset()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('propagates the auth error when the caller lacks admin', async () => {
    ;(requireRole as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new ForbiddenError())

    const res = await POST()
    expect(res.status).toBe(403)
  })

  it('400s when no bot token has been saved yet', async () => {
    accountRow = { telegram_bot_token: null }

    const res = await POST()
    expect(res.status).toBe(400)
  })

  it('404s when the bot has no updates to detect a chat from', async () => {
    getLatestTelegramChat.mockResolvedValueOnce(null)

    const res = await POST()
    expect(res.status).toBe(404)
  })

  it('returns the detected chat id and name', async () => {
    getLatestTelegramChat.mockResolvedValueOnce({ chatId: '999', name: 'Jane' })

    const res = await POST()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ chat_id: '999', name: 'Jane' })
  })

  it('maps a Telegram API failure to a 502', async () => {
    getLatestTelegramChat.mockRejectedValueOnce(new Error('Telegram API error: 401'))

    const res = await POST()
    expect(res.status).toBe(502)
  })
})
