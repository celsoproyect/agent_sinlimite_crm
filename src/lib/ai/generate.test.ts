import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateReply, parseGeneration } from './generate'
import { AiError, type AiConfig } from './types'

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    replyDelaySeconds: 0,
    temperature: 0.7,
    handoffAgentId: null,
    embeddingsApiKey: null,
    embeddingsModel: 'text-embedding-3-small',
    ...overrides,
  }
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      usage: null,
      attachments: [],
    })
  })

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      usage: null,
      attachments: [],
    })
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      usage: null,
      attachments: [],
    })
  })

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      usage,
      attachments: [],
    })
  })
})

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
      attachments: [],
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(401, { error: { message: 'Incorrect API key' } }),
      ),
    )

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: '' } }] })),
    )
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      }),
    ).rejects.toBeInstanceOf(AiError)
  })
})

describe('generateReply — temperature', () => {
  it('threads temperature through to the OpenAI request body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'ok' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'openai', model: 'gpt-test', temperature: 1.3 }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.temperature).toBe(1.3)
  })

  it('omits temperature for an OpenAI reasoning model that rejects it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'ok' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'openai', model: 'o1-mini', temperature: 1.3 }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body).not.toHaveProperty('temperature')
  })

  it('threads temperature through to the Anthropic request body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic', temperature: 0.2 }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.temperature).toBe(0.2)
  })
})

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
      attachments: [],
    })
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.anthropic.com')
    expect(opts.headers['x-api-key']).toBe('sk-ant-x')
    expect(opts.headers['anthropic-version']).toBeTruthy()
  })

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] }),
      ),
    )
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    })
    expect(res.handoff).toBe(true)
    expect(res.text).toBe('')
  })

  it('runs a tool-call round then returns the final text (OpenAI)', async () => {
    const execute = vi.fn().mockResolvedValue([
      { content: 'Ships in 3 days.', kbName: 'Shipping', title: 'Shipping FAQ' },
    ])
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
                    function: {
                      name: 'search_knowledge_base',
                      arguments: JSON.stringify({
                        query: 'shipping time',
                        knowledge_base: 'Shipping',
                      }),
                    },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          choices: [{ message: { content: 'It ships in 3 days!' } }],
          usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'How fast is shipping?' }],
      knowledgeBases: [{ name: 'Shipping', description: 'Shipping policies' }],
      searchKnowledgeBase: execute,
    })

    expect(res.text).toBe('It ships in 3 days!')
    expect(res.usage).toEqual({ promptTokens: 30, completionTokens: 11, totalTokens: 41 })
    expect(execute).toHaveBeenCalledWith({ query: 'shipping time', knowledgeBaseName: 'Shipping' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // Second call's body includes the tool result message.
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const toolMsg = secondBody.messages.find((m: { role: string }) => m.role === 'tool')
    expect(toolMsg.content).toContain('Ships in 3 days.')
  })

  it('forces a final tool-free round after MAX_TOOL_ROUNDS (OpenAI)', async () => {
    const execute = vi.fn().mockResolvedValue([])
    const toolCallResponse = () =>
      okResponse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_x',
                  type: 'function',
                  function: {
                    name: 'search_knowledge_base',
                    arguments: JSON.stringify({ query: 'q' }),
                  },
                },
              ],
            },
          },
        ],
      })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(toolCallResponse())
      .mockResolvedValueOnce(okResponse({ choices: [{ message: { content: 'Final answer.' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
      knowledgeBases: [{ name: 'General', description: 'General info' }],
      searchKnowledgeBase: execute,
    })

    expect(res.text).toBe('Final answer.')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    // The third (forced) call must not offer tools.
    const thirdBody = JSON.parse(fetchMock.mock.calls[2][1].body)
    expect(thirdBody.tools).toBeUndefined()
  })

  it('runs a tool-call round then returns the final text (Anthropic)', async () => {
    const execute = vi.fn().mockResolvedValue([
      { content: 'We accept returns within 30 days.', kbName: 'Policies', title: 'Returns' },
    ])
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'search_knowledge_base',
              input: { query: 'return policy', knowledge_base: 'Policies' },
            },
          ],
          usage: { input_tokens: 12, output_tokens: 4 },
        }),
      )
      .mockResolvedValueOnce(
        okResponse({
          content: [{ type: 'text', text: 'You can return it within 30 days.' }],
          usage: { input_tokens: 20, output_tokens: 8 },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Can I return this?' }],
      knowledgeBases: [{ name: 'Policies', description: 'Store policies' }],
      searchKnowledgeBase: execute,
    })

    expect(res.text).toBe('You can return it within 30 days.')
    expect(res.usage).toEqual({ promptTokens: 32, completionTokens: 12, totalTokens: 44 })
    expect(execute).toHaveBeenCalledWith({ query: 'return policy', knowledgeBaseName: 'Policies' })

    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const toolResultMsg = secondBody.messages.find(
      (m: { role: string; content: unknown }) =>
        m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
    )
    expect(toolResultMsg.content[0].content).toContain('We accept returns within 30 days.')
  })

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].role).toBe('user')
    expect(body.messages).toHaveLength(1)
  })
})

describe('generateReply — image content translation', () => {
  it('sends an image_url block for a vision-capable OpenAI model', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'I see a red shoe.' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'openai', model: 'gpt-4o' }),
      systemPrompt: 'sys',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', url: 'https://example.com/shoe.jpg' },
          ],
        },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const userMsg = body.messages.find((m: { role: string }) => m.role === 'user')
    expect(userMsg.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image_url', image_url: { url: 'https://example.com/shoe.jpg' } },
    ])
  })

  it('degrades an image to a text placeholder for a vision-unsupported OpenAI model', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ choices: [{ message: { content: 'ok' } }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'openai', model: 'o1-mini' }),
      systemPrompt: 'sys',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', url: 'https://example.com/shoe.jpg' },
          ],
        },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    const userMsg = body.messages.find((m: { role: string }) => m.role === 'user')
    expect(userMsg.content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'text', text: '[el cliente envió una imagen — este modelo no puede verla]' },
    ])
  })

  it('sends an Anthropic image block with a url source for a public URL', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'I see a red shoe.' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', url: 'https://example.com/shoe.jpg' },
          ],
        },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'What is this?' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/shoe.jpg' } },
    ])
  })

  it('sends an Anthropic image block with a base64 source for a data URI', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ content: [{ type: 'text', text: 'ok' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', url: 'data:image/png;base64,AAAA' }],
        },
      ],
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ])
  })
})

describe('generateReply — send_attachment tool loop', () => {
  it('resolves a catalog match and returns it in attachments (OpenAI)', async () => {
    const searchAttachments = vi.fn().mockResolvedValue([
      { name: 'Blue T-Shirt', kind: 'image', mediaUrl: 'https://example.com/shirt.jpg', filename: 'shirt.jpg' },
    ])
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
                    function: {
                      name: 'send_attachment',
                      arguments: JSON.stringify({ query: 'blue shirt' }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: 'Here you go!' } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Show me the blue shirt' }],
      searchAttachments,
    })

    expect(res.text).toBe('Here you go!')
    expect(res.attachments).toEqual([
      { name: 'Blue T-Shirt', kind: 'image', mediaUrl: 'https://example.com/shirt.jpg', filename: 'shirt.jpg' },
    ])
    expect(searchAttachments).toHaveBeenCalledWith({ query: 'blue shirt' })

    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const toolMsg = secondBody.messages.find((m: { role: string }) => m.role === 'tool')
    expect(JSON.parse(toolMsg.content)).toEqual({ found: true, name: 'Blue T-Shirt', kind: 'image' })
  })

  it('resolves both a knowledge search and a send_attachment call in the same round (OpenAI)', async () => {
    const searchKnowledgeBase = vi.fn().mockResolvedValue([
      { content: 'Ships in 3 days.', kbName: 'Shipping', title: 'Shipping FAQ' },
    ])
    const searchAttachments = vi.fn().mockResolvedValue([
      { name: 'Catalog PDF', kind: 'document', mediaUrl: 'https://example.com/cat.pdf', filename: 'cat.pdf' },
    ])
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
                    function: {
                      name: 'search_knowledge_base',
                      arguments: JSON.stringify({ query: 'shipping time' }),
                    },
                  },
                  {
                    id: 'call_2',
                    type: 'function',
                    function: {
                      name: 'send_attachment',
                      arguments: JSON.stringify({ query: 'catalog' }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: 'Ships in 3 days, catalog attached!' } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'When does it ship, and send me the catalog' }],
      knowledgeBases: [{ name: 'Shipping', description: 'Shipping policies' }],
      searchKnowledgeBase,
      searchAttachments,
    })

    expect(res.text).toBe('Ships in 3 days, catalog attached!')
    expect(res.attachments).toEqual([
      { name: 'Catalog PDF', kind: 'document', mediaUrl: 'https://example.com/cat.pdf', filename: 'cat.pdf' },
    ])
    expect(searchKnowledgeBase).toHaveBeenCalledWith({ query: 'shipping time', knowledgeBaseName: undefined })
    expect(searchAttachments).toHaveBeenCalledWith({ query: 'catalog' })
  })

  it('resolves a catalog match and returns it in attachments (Anthropic)', async () => {
    const searchAttachments = vi.fn().mockResolvedValue([
      { name: 'Blue T-Shirt', kind: 'image', mediaUrl: 'https://example.com/shirt.jpg', filename: 'shirt.jpg' },
    ])
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'send_attachment',
              input: { query: 'blue shirt' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(okResponse({ content: [{ type: 'text', text: 'Here you go!' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Show me the blue shirt' }],
      searchAttachments,
    })

    expect(res.text).toBe('Here you go!')
    expect(res.attachments).toEqual([
      { name: 'Blue T-Shirt', kind: 'image', mediaUrl: 'https://example.com/shirt.jpg', filename: 'shirt.jpg' },
    ])
    expect(searchAttachments).toHaveBeenCalledWith({ query: 'blue shirt' })

    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const toolResultMsg = secondBody.messages.find(
      (m: { role: string; content: unknown }) =>
        m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result',
    )
    expect(JSON.parse(toolResultMsg.content[0].content)).toEqual({
      found: true,
      name: 'Blue T-Shirt',
      kind: 'image',
    })
  })

  it('returns no attachments when the catalog has no match', async () => {
    const searchAttachments = vi.fn().mockResolvedValue([])
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
                    function: { name: 'send_attachment', arguments: JSON.stringify({ query: 'unicorn plush' }) },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: "Sorry, we don't have that." } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Send me a unicorn plush' }],
      searchAttachments,
    })

    expect(res.attachments).toEqual([])
  })
})

describe('generateReply — booking tool loop', () => {
  it('resolves an offered slot and returns it in booking.offer (OpenAI)', async () => {
    const checkAvailability = vi.fn().mockResolvedValue([
      { startsAt: '2026-08-24T14:00:00.000Z', endsAt: '2026-08-24T14:30:00.000Z' },
    ])
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
                    function: {
                      name: 'check_availability',
                      arguments: JSON.stringify({ date: '2026-08-24' }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: 'We have 2pm open, want that?' } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Can I book something Monday?' }],
      checkAvailability,
    })

    expect(res.text).toBe('We have 2pm open, want that?')
    expect(res.booking).toEqual({
      offer: [{ startsAt: '2026-08-24T14:00:00.000Z', endsAt: '2026-08-24T14:30:00.000Z' }],
    })
    expect(checkAvailability).toHaveBeenCalledWith({ date: '2026-08-24' })

    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const toolMsg = secondBody.messages.find((m: { role: string }) => m.role === 'tool')
    expect(JSON.parse(toolMsg.content)).toEqual({
      available: true,
      slots: [{ startsAt: '2026-08-24T14:00:00.000Z', time: expect.any(String) }],
    })
  })

  it('confirms a booking and returns it in booking.appointment (OpenAI)', async () => {
    const checkAvailability = vi.fn()
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
                    function: {
                      name: 'book_appointment',
                      arguments: JSON.stringify({
                        startsAt: '2026-08-24T14:00:00.000Z',
                        endsAt: '2026-08-24T14:30:00.000Z',
                        service: 'Haircut',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: 'Booked for 2pm!' } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Yes, 2pm works' }],
      checkAvailability,
    })

    expect(res.text).toBe('Booked for 2pm!')
    expect(res.booking).toEqual({
      appointment: {
        startsAt: '2026-08-24T14:00:00.000Z',
        endsAt: '2026-08-24T14:30:00.000Z',
        service: 'Haircut',
        notes: undefined,
      },
    })
    expect(checkAvailability).not.toHaveBeenCalled()

    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    const toolMsg = secondBody.messages.find((m: { role: string }) => m.role === 'tool')
    expect(JSON.parse(toolMsg.content)).toEqual({ confirmed: true })
  })

  it('rejects an incomplete book_appointment call and does not set booking.appointment (OpenAI)', async () => {
    const checkAvailability = vi.fn()
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
                    function: {
                      name: 'book_appointment',
                      arguments: JSON.stringify({ startsAt: '2026-08-24T14:00:00.000Z' }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        okResponse({ choices: [{ message: { content: 'Sorry, let me check that again.' } }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Book it' }],
      checkAvailability,
    })

    expect(res.booking).toBeUndefined()
  })

  it('resolves an offered slot and returns it in booking.offer (Anthropic)', async () => {
    const checkAvailability = vi.fn().mockResolvedValue([
      { startsAt: '2026-08-24T14:00:00.000Z', endsAt: '2026-08-24T14:30:00.000Z' },
    ])
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'check_availability',
              input: { date: '2026-08-24' },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(okResponse({ content: [{ type: 'text', text: 'We have 2pm open!' } ] }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Can I book something Monday?' }],
      checkAvailability,
    })

    expect(res.text).toBe('We have 2pm open!')
    expect(res.booking).toEqual({
      offer: [{ startsAt: '2026-08-24T14:00:00.000Z', endsAt: '2026-08-24T14:30:00.000Z' }],
    })
    expect(checkAvailability).toHaveBeenCalledWith({ date: '2026-08-24' })
  })

  it('confirms a booking and returns it in booking.appointment (Anthropic)', async () => {
    const checkAvailability = vi.fn()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        okResponse({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'book_appointment',
              input: {
                startsAt: '2026-08-24T14:00:00.000Z',
                endsAt: '2026-08-24T14:30:00.000Z',
                service: 'Haircut',
              },
            },
          ],
        }),
      )
      .mockResolvedValueOnce(okResponse({ content: [{ type: 'text', text: 'Booked for 2pm!' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Yes, 2pm works' }],
      checkAvailability,
    })

    expect(res.text).toBe('Booked for 2pm!')
    expect(res.booking).toEqual({
      appointment: {
        startsAt: '2026-08-24T14:00:00.000Z',
        endsAt: '2026-08-24T14:30:00.000Z',
        service: 'Haircut',
        notes: undefined,
      },
    })
  })
})
