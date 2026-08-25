import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const BASE_ROW = {
  booking_id: 'booking-1',
  account_id: 'acct-1',
  contact_id: 'contact-1',
  conversation_id: 'conv-1',
  service: 'Corte de cabello',
  starts_at: '2026-08-25T14:30:00.000Z',
  contact_name: 'Ana',
  contact_phone: '+50212345678',
  rule_id: 'rule-1',
  offset_minutes: 1440,
  message_text: 'Hola {{contact_name}}, recordatorio de {{service}} a las {{time}}.',
  template_name: null as string | null,
  template_language: null as string | null,
}

let dueRows: Record<string, unknown>[] = [{ ...BASE_ROW }]
let claimShouldConflict = false
const claimedInserts: Record<string, unknown>[] = []
const sendUpdates: { id: string; payload: Record<string, unknown> }[] = []

function makeAdmin() {
  return {
    rpc: vi.fn(async () => ({ data: dueRows, error: null })),
    from: vi.fn((table: string) => {
      if (table !== 'booking_reminder_sends') throw new Error(`unexpected table ${table}`)
      const b: Record<string, unknown> = {}
      b.insert = vi.fn((payload: Record<string, unknown>) => {
        claimedInserts.push(payload)
        if (claimShouldConflict) {
          return {
            select: () => ({
              single: () =>
                Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }),
            }),
          }
        }
        const id = `send-${claimedInserts.length}`
        return { select: () => ({ single: () => Promise.resolve({ data: { id }, error: null }) }) }
      })
      b.update = vi.fn((payload: Record<string, unknown>) => ({
        eq: (_col: string, val: string) => {
          sendUpdates.push({ id: val, payload })
          return Promise.resolve({ data: null, error: null })
        },
      }))
      return b
    }),
  }
}

vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: vi.fn(() => makeAdmin()) }))

const { engineSendText, engineSendTemplate } = vi.hoisted(() => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'wamid-text' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'wamid-template' })),
}))
vi.mock('@/lib/automations/meta-send', () => ({ engineSendText, engineSendTemplate }))

const { resolveConversationByPhone } = vi.hoisted(() => ({
  resolveConversationByPhone: vi.fn(async () => ({
    conversationId: 'conv-resolved',
    contactId: 'contact-1',
    contactCreated: false,
  })),
}))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({ resolveConversationByPhone }))

const { resolveAuditUserId, FakeContactError } = vi.hoisted(() => ({
  resolveAuditUserId: vi.fn(async () => 'owner-1'),
  FakeContactError: class FakeContactError extends Error {},
}))
vi.mock('@/lib/api/v1/contacts', () => ({ resolveAuditUserId, ContactError: FakeContactError }))

import { GET } from './route'

function req(secret: string | null) {
  const headers: Record<string, string> = {}
  if (secret !== null) headers['x-cron-secret'] = secret
  return new Request('http://localhost/api/bookings/reminders/cron', { headers })
}

describe('GET /api/bookings/reminders/cron', () => {
  beforeEach(() => {
    process.env.AUTOMATION_CRON_SECRET = 'cron-secret'
    dueRows = [{ ...BASE_ROW }]
    claimShouldConflict = false
    claimedInserts.length = 0
    sendUpdates.length = 0
    engineSendText.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid-text' })
    engineSendTemplate.mockReset().mockResolvedValue({ whatsapp_message_id: 'wamid-template' })
    resolveConversationByPhone.mockClear()
    resolveAuditUserId.mockReset().mockResolvedValue('owner-1')
  })
  afterEach(() => {
    delete process.env.AUTOMATION_CRON_SECRET
    vi.clearAllMocks()
  })

  it('503s when the cron secret is not configured', async () => {
    delete process.env.AUTOMATION_CRON_SECRET
    const res = await GET(req('anything'))
    expect(res.status).toBe(503)
  })

  it('401s on a missing or wrong secret', async () => {
    expect((await GET(req(null))).status).toBe(401)
    expect((await GET(req('wrong'))).status).toBe(401)
  })

  it('returns zeros when nothing is due', async () => {
    dueRows = []
    const res = await GET(req('cron-secret'))
    const json = await res.json()
    expect(json).toEqual({ processed: 0, sent: 0, failed: 0 })
  })

  it('sends the personalized free-text reminder on the happy path', async () => {
    const res = await GET(req('cron-secret'))
    const json = await res.json()
    expect(json).toEqual({ processed: 1, sent: 1, failed: 0 })

    expect(resolveConversationByPhone).not.toHaveBeenCalled()
    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acct-1',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        text: 'Hola Ana, recordatorio de Corte de cabello a las 14:30.',
      }),
    )
    expect(engineSendTemplate).not.toHaveBeenCalled()
    expect(sendUpdates).toEqual([{ id: 'send-1', payload: { status: 'sent', channel: 'text' } }])
  })

  it('resolves a conversation when the booking has none', async () => {
    dueRows = [{ ...BASE_ROW, conversation_id: null }]
    await GET(req('cron-secret'))

    expect(resolveConversationByPhone).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      '+50212345678',
      'Ana',
    )
    expect(engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-resolved' }),
    )
  })

  it('skips a row already claimed by another cron run', async () => {
    claimShouldConflict = true
    const res = await GET(req('cron-secret'))
    const json = await res.json()
    expect(json).toEqual({ processed: 0, sent: 0, failed: 0 })
    expect(engineSendText).not.toHaveBeenCalled()
  })

  it('falls back to the template when the text send is rejected for being outside the session window', async () => {
    dueRows = [{ ...BASE_ROW, template_name: 'reminder_24h', template_language: 'es_MX' }]
    engineSendText.mockRejectedValueOnce(
      new Error('(#131047) Message failed to send because more than 24 hours have passed since the customer last replied to this number.'),
    )

    const res = await GET(req('cron-secret'))
    const json = await res.json()
    expect(json).toEqual({ processed: 1, sent: 1, failed: 0 })

    expect(engineSendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateName: 'reminder_24h',
        language: 'es_MX',
        params: ['Ana', 'Corte de cabello', '2026-08-25', '14:30'],
      }),
    )
    expect(sendUpdates).toEqual([{ id: 'send-1', payload: { status: 'sent', channel: 'template' } }])
  })

  it('marks the send failed when outside the window and no fallback template is configured', async () => {
    engineSendText.mockRejectedValueOnce(new Error('(#131047) re-engagement required'))

    const res = await GET(req('cron-secret'))
    const json = await res.json()
    expect(json).toEqual({ processed: 1, sent: 0, failed: 1 })
    expect(engineSendTemplate).not.toHaveBeenCalled()
    expect(sendUpdates).toEqual([
      { id: 'send-1', payload: { status: 'failed', error: '(#131047) re-engagement required' } },
    ])
  })

  it('marks the send failed on an unrelated error without trying the template', async () => {
    dueRows = [{ ...BASE_ROW, template_name: 'reminder_24h' }]
    engineSendText.mockRejectedValueOnce(new Error('WhatsApp not configured'))

    const res = await GET(req('cron-secret'))
    const json = await res.json()
    expect(json).toEqual({ processed: 1, sent: 0, failed: 1 })
    expect(engineSendTemplate).not.toHaveBeenCalled()
  })
})
