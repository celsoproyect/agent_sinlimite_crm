import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  checkAvailability: vi.fn(),
  retrieveKnowledge: vi.fn(),
  searchAttachments: vi.fn(),
}))
vi.mock('./booking', () => ({ checkAvailability: h.checkAvailability }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./attachments', () => ({ searchAttachments: h.searchAttachments }))

import { generateOpsReply, buildOpsSystemPrompt, runOpsTool } from './ops-assistant'
import type { AiConfig } from './types'

function config(overrides: Partial<Pick<AiConfig, 'provider' | 'model' | 'apiKey'>> = {}) {
  return { provider: 'openai' as const, model: 'gpt-test', apiKey: 'sk-test', ...overrides }
}

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

/** Minimal stand-in for a Supabase query builder: every chain method
 *  returns itself, and awaiting it resolves to the canned response for
 *  that `.from(table)` call. */
function chain(response: unknown) {
  const builder: Record<string, unknown> = {}
  const chainMethods = ['select', 'eq', 'gte', 'lte', 'in', 'not', 'order', 'limit']
  for (const m of chainMethods) builder[m] = vi.fn(() => builder)
  builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
    Promise.resolve(response).then(resolve, reject)
  return builder
}

function makeDb(tableResponses: Record<string, unknown>) {
  return { from: vi.fn((table: string) => chain(tableResponses[table])) }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
  h.checkAvailability.mockReset()
  h.retrieveKnowledge.mockReset()
  h.searchAttachments.mockReset()
})
afterEach(() => vi.unstubAllGlobals())

describe('buildOpsSystemPrompt', () => {
  it('states this is never a customer conversation and has no message-content access', () => {
    const prompt = buildOpsSystemPrompt()
    expect(prompt).toMatch(/never.*customer conversation/i)
    expect(prompt).toMatch(/do not have.*access to the content/i)
  })
})

describe('generateOpsReply — no tool call', () => {
  it('returns the plain text reply', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'No sé — preguntame algo del negocio.' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateOpsReply({
      db: makeDb({}) as never,
      accountId: 'acct-1',
      config: config(),
      history: [],
      userMessage: 'hola',
    })

    expect(res.text).toBe('No sé — preguntame algo del negocio.')
  })

  it('throws when OpenAI returns an empty response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })))

    await expect(
      generateOpsReply({
        db: makeDb({}) as never,
        accountId: 'acct-1',
        config: config(),
        history: [],
        userMessage: 'hola',
      }),
    ).rejects.toMatchObject({ code: 'empty_response' })
  })
})

describe('generateOpsReply — count_conversations tool (OpenAI)', () => {
  it('scopes the query by accountId and returns the count', async () => {
    const db = makeDb({ conversations: { count: 5, error: null } })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'count_conversations', arguments: JSON.stringify({ status: 'open' }) },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(okResponse({ choices: [{ message: { content: 'Tenés 5 conversaciones abiertas.' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateOpsReply({
      db: db as never,
      accountId: 'acct-1',
      config: config(),
      history: [],
      userMessage: '¿cuántas conversaciones abiertas hay?',
    })

    expect(res.text).toBe('Tenés 5 conversaciones abiertas.')
    expect(db.from).toHaveBeenCalledWith('conversations')

    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const toolMsg = secondBody.messages.find((m: { role: string }) => m.role === 'tool')
    expect(JSON.parse(toolMsg.content)).toEqual({ count: 5 })
  })
})

describe('generateOpsReply — count_won_deals tool (OpenAI)', () => {
  it('filters deals by status=won', async () => {
    const db = makeDb({ deals: { count: 3, error: null } })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: 'call_1', type: 'function', function: { name: 'count_won_deals', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(okResponse({ choices: [{ message: { content: 'Cerraste 3 ventas.' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateOpsReply({
      db: db as never,
      accountId: 'acct-1',
      config: config(),
      history: [],
      userMessage: '¿cuántos clientes compraron?',
    })

    expect(res.text).toBe('Cerraste 3 ventas.')
    expect(db.from).toHaveBeenCalledWith('deals')
  })
})

describe('generateOpsReply — list_stale_conversations tool (OpenAI)', () => {
  it('returns only contacts whose last message is from the customer, never message content', async () => {
    const db = makeDb({
      conversations: {
        data: [
          { id: 'c1', last_message_at: '2026-08-01T00:00:00Z', contacts: { name: 'Ana' } },
          { id: 'c2', last_message_at: '2026-08-02T00:00:00Z', contacts: { name: 'Luis' } },
        ],
        error: null,
      },
      messages: {
        data: [
          { conversation_id: 'c2', sender_type: 'agent', created_at: '2026-08-03T00:00:00Z' },
          { conversation_id: 'c1', sender_type: 'customer', created_at: '2026-08-01T01:00:00Z' },
        ],
        error: null,
      },
    })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'list_stale_conversations', arguments: JSON.stringify({ limit: 5 }) },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(okResponse({ choices: [{ message: { content: 'Ana está esperando respuesta.' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateOpsReply({
      db: db as never,
      accountId: 'acct-1',
      config: config(),
      history: [],
      userMessage: '¿a quién le debo seguimiento?',
    })

    expect(res.text).toBe('Ana está esperando respuesta.')

    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const toolMsg = secondBody.messages.find((m: { role: string }) => m.role === 'tool')
    const toolResult = JSON.parse(toolMsg.content)
    expect(toolResult.conversations).toEqual([{ contactName: 'Ana', waitingHours: expect.any(Number) }])
  })
})

describe('generateOpsReply — Anthropic, no tool call', () => {
  it('sends the system prompt separately and returns the text block', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({ content: [{ type: 'text', text: 'Todo tranquilo por ahora.' }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateOpsReply({
      db: makeDb({}) as never,
      accountId: 'acct-1',
      config: config({ provider: 'anthropic', model: 'claude-test' }),
      history: [],
      userMessage: '¿algo urgente?',
    })

    expect(res.text).toBe('Todo tranquilo por ahora.')
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    const body = JSON.parse(opts.body)
    expect(typeof body.system).toBe('string')
    expect(body.system).toMatch(/never.*customer conversation/i)
  })
})

describe('runOpsTool — owner tools', () => {
  it('check_free_slots returns slots in business-local time', async () => {
    h.checkAvailability.mockResolvedValue({
      slots: [{ startsAt: '2026-10-08T13:00:00.000Z', endsAt: '2026-10-08T14:00:00.000Z' }],
    })
    const out = JSON.parse(await runOpsTool(makeDb({}) as never, 'acct-1', 'check_free_slots', { date: '2026-10-08' }))
    expect(h.checkAvailability).toHaveBeenCalledWith(expect.anything(), 'acct-1', '2026-10-08', undefined, 6)
    expect(out.freeSlots).toEqual([{ date: '2026-10-08', time: '09:00', endsAt: '10:00' }])
  })

  it('check_free_slots rejects a malformed date', async () => {
    const out = JSON.parse(await runOpsTool(makeDb({}) as never, 'acct-1', 'check_free_slots', { date: 'jueves' }))
    expect(out.error).toBeDefined()
    expect(h.checkAvailability).not.toHaveBeenCalled()
  })

  it('list_new_contacts tags each contact with the channel of its first conversation', async () => {
    const db = makeDb({
      contacts: {
        data: [
          { id: 'c1', name: 'Ana', phone: '18095550101', created_at: '2026-10-05T15:00:00Z' },
          { id: 'c2', name: 'Visitante web', phone: '000552783865689820242', created_at: '2026-10-04T15:00:00Z' },
        ],
        count: 2,
        error: null,
      },
      conversations: {
        data: [
          { contact_id: 'c1', channel: 'whatsapp' },
          { contact_id: 'c2', channel: 'web' },
        ],
        error: null,
      },
    })
    const out = JSON.parse(await runOpsTool(db as never, 'acct-1', 'list_new_contacts', { from: '2026-10-01' }))
    expect(out.count).toBe(2)
    expect(out.contacts).toEqual([
      { name: 'Ana', phone: '18095550101', source: 'whatsapp', createdAt: '2026-10-05 11:00' },
      { name: 'Visitante web', phone: null, source: 'web widget', createdAt: '2026-10-04 11:00' },
    ])
  })

  it('sales_summary totals won amounts, lost reasons and the open funnel by stage', async () => {
    const responses = [
      {
        data: [
          { value: 30000, currency: 'DOP', status: 'won', lost_reason: null },
          { value: '15000', currency: 'DOP', status: 'won', lost_reason: null },
          { value: 0, currency: 'DOP', status: 'lost', lost_reason: 'price' },
        ],
        error: null,
      },
      {
        data: [
          { value: 8500, currency: 'DOP', pipeline_stages: { name: 'Propuesta', position: 2 } },
          { value: 4500, currency: 'DOP', pipeline_stages: { name: 'Nuevo', position: 0 } },
        ],
        error: null,
      },
    ]
    const db = { from: vi.fn(() => chain(responses.shift())) }
    const out = JSON.parse(await runOpsTool(db as never, 'acct-1', 'sales_summary', { from: '2026-10-01' }))
    expect(out.won).toEqual({ count: 2, amountByCurrency: { DOP: 45000 } })
    expect(out.lost).toEqual({ count: 1, reasons: { price: 1 } })
    expect(out.winRatePercent).toBe(67)
    expect(out.openPipeline.map((s: { stage: string }) => s.stage)).toEqual(['Nuevo', 'Propuesta'])
  })

  it('sales_summary falls back to updated_at before migration 063', async () => {
    const responses = [
      // closed deals by closed_at, then the open funnel, then the retry
      { data: null, error: { code: '42703' } },
      { data: [], error: null },
      { data: [{ value: 100, currency: 'USD', status: 'won' }], error: null },
    ]
    const db = { from: vi.fn(() => chain(responses.shift())) }
    const out = JSON.parse(await runOpsTool(db as never, 'acct-1', 'sales_summary', {}))
    expect(out.won).toEqual({ count: 1, amountByCurrency: { USD: 100 } })
  })

  it('search_business_info returns catalog items with prices and knowledge excerpts', async () => {
    h.retrieveKnowledge.mockResolvedValue([{ content: 'Garantía de 30 días', kbName: 'Atención', title: 'Políticas' }])
    h.searchAttachments.mockResolvedValue([
      { name: 'Plan Profesional', description: 'Agente IA', price: 30000, currency: 'DOP' },
    ])
    const out = JSON.parse(
      await runOpsTool(makeDb({}) as never, 'acct-1', 'search_business_info', { query: 'plan profesional' }, {
        embeddings: { embeddingsApiKey: 'sk-emb' },
      }),
    )
    expect(h.retrieveKnowledge).toHaveBeenCalledWith(expect.anything(), 'acct-1', { embeddingsApiKey: 'sk-emb' }, 'plan profesional', 5)
    expect(out.catalog).toEqual([{ name: 'Plan Profesional', description: 'Agente IA', price: 30000, currency: 'DOP' }])
    expect(out.knowledge).toEqual([{ source: 'Políticas', text: 'Garantía de 30 días' }])
  })
})
