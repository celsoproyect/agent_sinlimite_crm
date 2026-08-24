import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { transcribeAudio } from './audio'
import { AiError } from './types'

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

describe('transcribeAudio', () => {
  it('posts a multipart form to the Whisper endpoint and returns the transcript', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ text: 'Hola, quiero hacer un pedido.' }))
    vi.stubGlobal('fetch', fetchMock)

    const text = await transcribeAudio('sk-test', {
      buffer: Buffer.from('fake-audio-bytes'),
      contentType: 'audio/ogg',
    })

    expect(text).toBe('Hola, quiero hacer un pedido.')
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('api.openai.com/v1/audio/transcriptions')
    expect(opts.method).toBe('POST')
    expect(opts.headers.Authorization).toBe('Bearer sk-test')
    expect(opts.body).toBeInstanceOf(FormData)
  })

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(errResponse(401, { error: { message: 'Incorrect API key' } })),
    )

    await expect(
      transcribeAudio('sk-bad', { buffer: Buffer.from('x'), contentType: 'audio/ogg' }),
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 })
  })

  it('throws a typed error when the response body is malformed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse({ not_text: 'oops' })))

    await expect(
      transcribeAudio('sk-test', { buffer: Buffer.from('x'), contentType: 'audio/ogg' }),
    ).rejects.toBeInstanceOf(AiError)
  })

  it('maps a network failure to a network_error AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    )

    await expect(
      transcribeAudio('sk-test', { buffer: Buffer.from('x'), contentType: 'audio/ogg' }),
    ).rejects.toMatchObject({ code: 'network_error' })
  })
})
