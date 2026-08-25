import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetRateLimitForTests } from '@/lib/rate-limit'

const LEAD_FORM_KEY = '11111111-1111-1111-1111-111111111111'

const ACCOUNT_BASE = {
  id: 'acct-1',
  owner_user_id: 'owner-1',
  lead_form_enabled: true,
  telegram_notify_enabled: false,
  telegram_bot_token: null as string | null,
  telegram_chat_id: null as string | null,
}

let account: Record<string, unknown> | null = { ...ACCOUNT_BASE }
let existingContact: Record<string, unknown> | null = null
let existingPipeline: Record<string, unknown> | null = { id: 'pipeline-1' }
let existingStage: Record<string, unknown> | null = { id: 'stage-1' }
let existingCustomFields: Record<string, Record<string, unknown>> = {}

const contactInserts: Record<string, unknown>[] = []
const customFieldInserts: Record<string, unknown>[] = []
const customValueUpserts: Record<string, unknown>[] = []
const dealInserts: Record<string, unknown>[] = []

function builder(table: string) {
  let didInsert = false
  let didUpsert = false
  let insertPayload: Record<string, unknown> | null = null

  const selectResult = () => {
    switch (table) {
      case 'accounts':
        return { data: account, error: null }
      case 'contacts':
        return { data: existingContact, error: null }
      case 'custom_fields': {
        // Look up by field_name — the test doesn't have access to the
        // `.eq()` chain's arguments here, so track the last requested
        // name via a module-level var set from `.eq()` below.
        const row = existingCustomFields[lastCustomFieldNameQueried]
        return { data: row ?? null, error: null }
      }
      case 'pipelines':
        return { data: existingPipeline, error: null }
      case 'pipeline_stages':
        return { data: existingStage, error: null }
      default:
        return { data: null, error: null }
    }
  }

  const insertResult = () => {
    if (table === 'contacts') {
      const created = { id: 'contact-new', name: insertPayload?.name }
      contactInserts.push(insertPayload!)
      return { data: created, error: null }
    }
    if (table === 'custom_fields') {
      customFieldInserts.push(insertPayload!)
      const created = { id: `cf-${(insertPayload as Record<string, unknown>).field_name}` }
      return { data: created, error: null }
    }
    if (table === 'deals') {
      dealInserts.push(insertPayload!)
      return { data: { id: 'deal-new' }, error: null }
    }
    return { data: null, error: null }
  }

  const b: Record<string, unknown> = {}
  const chain = () => b
  b.select = vi.fn(chain)
  b.order = vi.fn(chain)
  b.limit = vi.fn(chain)
  b.eq = vi.fn((col: string, val: unknown) => {
    if (table === 'custom_fields' && col === 'field_name') {
      lastCustomFieldNameQueried = String(val)
    }
    return b
  })
  b.ilike = vi.fn(chain)
  b.insert = vi.fn((payload: Record<string, unknown>) => {
    didInsert = true
    insertPayload = payload
    return b
  })
  b.upsert = vi.fn((payload: Record<string, unknown>) => {
    didUpsert = true
    customValueUpserts.push(payload)
    return b
  })
  const terminal = () =>
    Promise.resolve(didInsert ? insertResult() : didUpsert ? { data: null, error: null } : selectResult())
  b.single = vi.fn(terminal)
  b.maybeSingle = vi.fn(terminal)
  b.then = (resolve: (v: unknown) => unknown) => resolve(terminal())
  return b
}

let lastCustomFieldNameQueried = ''

vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({ from: (table: string) => builder(table) }),
}))

const { sendTelegramMessage } = vi.hoisted(() => ({
  sendTelegramMessage: vi.fn(async () => undefined),
}))
vi.mock('@/lib/telegram/send', () => ({ sendTelegramMessage }))

import { POST } from './route'

function submit(body: Record<string, unknown>, key = LEAD_FORM_KEY) {
  return POST(
    new Request(`http://localhost/api/leads/${key}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ leadFormKey: key }) },
  )
}

const VALID_BODY = {
  full_name: 'Jane Doe',
  email: 'jane@example.com',
  company: 'Acme Inc',
  service: 'Consultoría',
  employee_count: '11-50',
  message: 'Quiero más información',
}

describe('POST /api/leads/[leadFormKey]/submit', () => {
  beforeEach(() => {
    __resetRateLimitForTests()
    account = { ...ACCOUNT_BASE }
    existingContact = null
    existingPipeline = { id: 'pipeline-1' }
    existingStage = { id: 'stage-1' }
    existingCustomFields = {}
    contactInserts.length = 0
    customFieldInserts.length = 0
    customValueUpserts.length = 0
    dealInserts.length = 0
    sendTelegramMessage.mockClear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('404s on a malformed key without hitting the database', async () => {
    const res = await submit(VALID_BODY, 'not-a-uuid')
    expect(res.status).toBe(404)
  })

  it('404s when no account matches the key', async () => {
    account = null
    const res = await submit(VALID_BODY)
    expect(res.status).toBe(404)
  })

  it('404s when the connector is disabled for the account', async () => {
    account = { ...ACCOUNT_BASE, lead_form_enabled: false }
    const res = await submit(VALID_BODY)
    expect(res.status).toBe(404)
  })

  it('400s when full_name is missing', async () => {
    const res = await submit({ ...VALID_BODY, full_name: '' })
    expect(res.status).toBe(400)
  })

  it('400s when email is invalid', async () => {
    const res = await submit({ ...VALID_BODY, email: 'not-an-email' })
    expect(res.status).toBe(400)
  })

  it('creates a contact, saves custom fields, and opens a deal', async () => {
    const res = await submit(VALID_BODY)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.contact_id).toBe('contact-new')
    expect(json.deal_id).toBe('deal-new')

    expect(contactInserts).toHaveLength(1)
    expect(contactInserts[0]).toMatchObject({
      account_id: 'acct-1',
      name: 'Jane Doe',
      email: 'jane@example.com',
      company: 'Acme Inc',
    })

    // Three custom fields provisioned: service, employee_count, message.
    expect(customFieldInserts).toHaveLength(3)
    expect(customValueUpserts).toHaveLength(3)

    expect(dealInserts).toHaveLength(1)
    expect(dealInserts[0]).toMatchObject({
      pipeline_id: 'pipeline-1',
      stage_id: 'stage-1',
      contact_id: 'contact-new',
    })
  })

  it('reuses an existing contact matched by email instead of creating a duplicate', async () => {
    existingContact = { id: 'contact-existing', name: 'Jane Doe' }
    const res = await submit(VALID_BODY)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.contact_id).toBe('contact-existing')
    expect(contactInserts).toHaveLength(0)
  })

  it('skips deal creation gracefully when the account has no pipeline', async () => {
    existingPipeline = null
    const res = await submit(VALID_BODY)
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.deal_id).toBeNull()
    expect(dealInserts).toHaveLength(0)
  })

  it('does not notify Telegram when notifications are disabled', async () => {
    account = {
      ...ACCOUNT_BASE,
      telegram_notify_enabled: false,
      telegram_bot_token: 'tok',
      telegram_chat_id: 'chat',
    }
    const res = await submit(VALID_BODY)
    expect(res.status).toBe(200)
    expect(sendTelegramMessage).not.toHaveBeenCalled()
  })

  it('notifies Telegram with the lead summary when enabled and configured', async () => {
    account = {
      ...ACCOUNT_BASE,
      telegram_notify_enabled: true,
      telegram_bot_token: 'tok',
      telegram_chat_id: 'chat',
    }
    const res = await submit(VALID_BODY)
    expect(res.status).toBe(200)

    expect(sendTelegramMessage).toHaveBeenCalledTimes(1)
    const args = (sendTelegramMessage.mock.calls[0] as unknown[])[0] as {
      botToken: string
      chatId: string
      text: string
    }
    expect(args.botToken).toBe('tok')
    expect(args.chatId).toBe('chat')
    expect(args.text).toContain('Jane Doe')
    expect(args.text).toContain('jane@example.com')
  })

  it('still returns success when the Telegram notify fails (best-effort)', async () => {
    account = {
      ...ACCOUNT_BASE,
      telegram_notify_enabled: true,
      telegram_bot_token: 'tok',
      telegram_chat_id: 'chat',
    }
    sendTelegramMessage.mockRejectedValueOnce(new Error('network down'))

    const res = await submit(VALID_BODY)
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
  })

  it('429s once the per-key+IP rate limit is exceeded', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await submit({ ...VALID_BODY, email: `lead${i}@example.com` })
      expect(res.status).toBe(200)
    }
    const res = await submit(VALID_BODY)
    expect(res.status).toBe(429)
  })

  it('handles OPTIONS preflight with CORS headers', async () => {
    const { OPTIONS } = await import('./route')
    const res = await OPTIONS()
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*')
  })
})
