import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetRateLimitForTests } from '@/lib/rate-limit'

const ACCOUNT_ID = '11111111-1111-1111-1111-111111111111'

const ACCOUNT_BASE = {
  telegram_admin_chat_enabled: true,
  telegram_webhook_secret: 'the-secret',
  telegram_bot_token: 'bot-token',
  telegram_chat_id: '999',
}

let account: Record<string, unknown> | null = { ...ACCOUNT_BASE }
let pastTurns: { role: string; content: string }[] = []
const insertedTurns: Record<string, unknown>[] = []

function makeDb() {
  return {
    from: vi.fn((table: string) => {
      if (table === 'accounts') {
        const b: Record<string, unknown> = {}
        b.select = vi.fn(() => b)
        b.eq = vi.fn(() => b)
        b.maybeSingle = vi.fn(() => Promise.resolve({ data: account, error: null }))
        return b
      }
      if (table === 'telegram_admin_turns') {
        const b: Record<string, unknown> = {}
        b.select = vi.fn(() => b)
        b.eq = vi.fn(() => b)
        b.order = vi.fn(() => b)
        b.limit = vi.fn(() => Promise.resolve({ data: pastTurns, error: null }))
        b.insert = vi.fn((rows: Record<string, unknown>[]) => {
          insertedTurns.push(...rows)
          return Promise.resolve({ data: null, error: null })
        })
        return b
      }
      throw new Error(`unexpected table ${table}`)
    }),
  }
}

let currentDb = makeDb()

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: vi.fn(() => currentDb),
}))

const { loadAiConfig } = vi.hoisted(() => ({ loadAiConfig: vi.fn() }))
vi.mock('@/lib/ai/config', () => ({ loadAiConfig }))

const { generateOpsReply } = vi.hoisted(() => ({ generateOpsReply: vi.fn() }))
vi.mock('@/lib/ai/ops-assistant', () => ({ generateOpsReply }))

const { sendTelegramMessage } = vi.hoisted(() => ({ sendTelegramMessage: vi.fn(async () => undefined) }))
vi.mock('@/lib/telegram/send', () => ({ sendTelegramMessage }))

import { POST } from './route'

function post(
  body: unknown,
  { secret = 'the-secret', accountId = ACCOUNT_ID }: { secret?: string | null; accountId?: string } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret
  return POST(
    new Request(`http://localhost/api/telegram/webhook/${accountId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ accountId }) },
  )
}

const UPDATE = { message: { chat: { id: 999 }, text: '¿cuántas citas hubo esta semana?' } }

describe('POST /api/telegram/webhook/[accountId]', () => {
  beforeEach(() => {
    __resetRateLimitForTests()
    account = { ...ACCOUNT_BASE }
    pastTurns = []
    insertedTurns.length = 0
    currentDb = makeDb()
    loadAiConfig.mockReset().mockResolvedValue({ provider: 'openai', model: 'gpt-test', apiKey: 'sk-test' })
    generateOpsReply.mockReset().mockResolvedValue({ text: 'Tuviste 4 citas esta semana.', usage: null })
    sendTelegramMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('always responds 200 with no body', async () => {
    const res = await post(UPDATE)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })

  it('no-ops when the secret header is missing', async () => {
    const res = await post(UPDATE, { secret: null })
    expect(res.status).toBe(200)
    expect(sendTelegramMessage).not.toHaveBeenCalled()
    expect(generateOpsReply).not.toHaveBeenCalled()
  })

  it('no-ops when the secret header does not match', async () => {
    const res = await post(UPDATE, { secret: 'wrong-secret' })
    expect(res.status).toBe(200)
    expect(sendTelegramMessage).not.toHaveBeenCalled()
    expect(generateOpsReply).not.toHaveBeenCalled()
  })

  it('no-ops when the account cannot be found', async () => {
    account = null
    const res = await post(UPDATE)
    expect(res.status).toBe(200)
    expect(sendTelegramMessage).not.toHaveBeenCalled()
  })

  it('no-ops when telegram_admin_chat_enabled is false', async () => {
    account = { ...ACCOUNT_BASE, telegram_admin_chat_enabled: false }
    const res = await post(UPDATE)
    expect(res.status).toBe(200)
    expect(sendTelegramMessage).not.toHaveBeenCalled()
  })

  it('no-ops when the bot token or chat id is missing', async () => {
    account = { ...ACCOUNT_BASE, telegram_bot_token: null }
    const res = await post(UPDATE)
    expect(res.status).toBe(200)
    expect(sendTelegramMessage).not.toHaveBeenCalled()
  })

  it('no-ops when the update comes from a chat other than the verified one', async () => {
    const res = await post({ message: { chat: { id: 12345 }, text: 'hola' } })
    expect(res.status).toBe(200)
    expect(sendTelegramMessage).not.toHaveBeenCalled()
    expect(generateOpsReply).not.toHaveBeenCalled()
  })

  it('no-ops on an empty/missing text', async () => {
    const res = await post({ message: { chat: { id: 999 }, text: '   ' } })
    expect(res.status).toBe(200)
    expect(generateOpsReply).not.toHaveBeenCalled()
  })

  it('no-ops on malformed JSON', async () => {
    const res = await POST(
      new Request(`http://localhost/api/telegram/webhook/${ACCOUNT_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': 'the-secret' },
        body: '{not json',
      }),
      { params: Promise.resolve({ accountId: ACCOUNT_ID }) },
    )
    expect(res.status).toBe(200)
    expect(generateOpsReply).not.toHaveBeenCalled()
  })

  it('sends a wait message and skips the AI call when rate-limited', async () => {
    for (let i = 0; i < 20; i++) {
      await post(UPDATE)
    }
    sendTelegramMessage.mockClear()
    generateOpsReply.mockClear()

    const res = await post(UPDATE)
    expect(res.status).toBe(200)
    expect(generateOpsReply).not.toHaveBeenCalled()
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: 'bot-token', chatId: '999', text: expect.stringMatching(/esper/i) }),
    )
  })

  it('tells the owner the AI is not configured yet when loadAiConfig returns null', async () => {
    loadAiConfig.mockResolvedValue(null)
    const res = await post(UPDATE)
    expect(res.status).toBe(200)
    expect(generateOpsReply).not.toHaveBeenCalled()
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: 'bot-token', chatId: '999', text: expect.stringMatching(/no está configurado/i) }),
    )
  })

  it('sends a fallback message and does not persist turns when generateOpsReply throws', async () => {
    generateOpsReply.mockRejectedValue(new Error('boom'))
    const res = await post(UPDATE)
    expect(res.status).toBe(200)
    expect(sendTelegramMessage).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: 'bot-token', chatId: '999', text: expect.stringMatching(/no pude procesar/i) }),
    )
    expect(insertedTurns).toHaveLength(0)
  })

  it('happy path: calls generateOpsReply with the account-scoped history, persists both turns, and replies', async () => {
    // The mock stands in for `.order('created_at', { ascending: false })` —
    // newest first, same as the real query — the route reverses this
    // itself to build chronological history.
    pastTurns = [
      { role: 'assistant', content: 'Tuviste 2 contactos nuevos.' },
      { role: 'user', content: '¿cuántos contactos nuevos hubo?' },
    ]

    const res = await post(UPDATE)
    expect(res.status).toBe(200)

    expect(generateOpsReply).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: ACCOUNT_ID,
        userMessage: '¿cuántas citas hubo esta semana?',
        history: [
          { role: 'user', content: '¿cuántos contactos nuevos hubo?' },
          { role: 'assistant', content: 'Tuviste 2 contactos nuevos.' },
        ],
      }),
    )

    expect(insertedTurns).toEqual([
      { account_id: ACCOUNT_ID, role: 'user', content: '¿cuántas citas hubo esta semana?' },
      { account_id: ACCOUNT_ID, role: 'assistant', content: 'Tuviste 4 citas esta semana.' },
    ])

    expect(sendTelegramMessage).toHaveBeenCalledWith({
      botToken: 'bot-token',
      chatId: '999',
      text: 'Tuviste 4 citas esta semana.',
    })
  })
})
