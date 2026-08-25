import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateOpsReply, buildOpsSystemPrompt } from './ops-assistant'
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
function makeDb(tableResponses: Record<string, unknown>) {
  return {
    from: vi.fn((table: string) => {
      const builder: Record<string, unknown> = {}
      const chainMethods = ['select', 'eq', 'gte', 'lte', 'in', 'not', 'order', 'limit']
      for (const m of chainMethods) builder[m] = vi.fn(() => builder)
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(tableResponses[table]).then(resolve, reject)
      return builder
    }),
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
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
