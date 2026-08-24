import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'
import { resolveMediaBytes } from './media-resolve'
import { transcribeAudio } from './audio'
import { extractTextFromFile } from './extract-text'

vi.mock('./media-resolve', () => ({ resolveMediaBytes: vi.fn() }))
vi.mock('./audio', () => ({ transcribeAudio: vi.fn() }))
vi.mock('./extract-text', async () => {
  const actual = await vi.importActual<typeof import('./extract-text')>('./extract-text')
  return { ...actual, extractTextFromFile: vi.fn() }
})

const resolveMediaBytesMock = vi.mocked(resolveMediaBytes)
const transcribeAudioMock = vi.mocked(transcribeAudio)
const extractTextFromFileMock = vi.mocked(extractTextFromFile)

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().order().limit() → { data, error }; also supports
 *  the transcript-cache write path (from('messages').update().eq()). */
function fakeDb(rows: unknown[]): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
    update: () => ({
      eq: () => Promise.resolve({ error: null }),
    }),
  }
  return chain as unknown as SupabaseClient
}

const opts = { accountId: 'acct-1', embeddingsApiKey: null as string | null }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildConversationContext — text', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third', content_type: 'text' },
      { sender_type: 'agent', content_text: 'second', content_type: 'text' },
      { sender_type: 'customer', content_text: 'first', content_type: 'text' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', opts)
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply', content_type: 'text' }]),
      'conv-1',
      opts,
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ', content_type: 'text' },
        { sender_type: 'customer', content_text: null, content_type: 'text' },
        { sender_type: 'customer', content_text: 'real', content_type: 'text' },
      ]),
      'conv-1',
      opts,
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('falls back to a placeholder for an unsupported content type', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'customer', content_text: null, content_type: 'location' }]),
      'conv-1',
      opts,
    )
    expect(out).toEqual([{ role: 'user', content: '[mensaje de tipo location]' }])
  })
})

describe('buildConversationContext — images', () => {
  it('resolves a public bucket URL directly, without downloading bytes', async () => {
    const rows = [
      {
        sender_type: 'customer',
        content_text: 'look at this',
        content_type: 'image',
        media_url: 'https://chat-media.example.com/photo.jpg',
      },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', opts)
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image', url: 'https://chat-media.example.com/photo.jpg' },
        ],
      },
    ])
    expect(resolveMediaBytesMock).not.toHaveBeenCalled()
  })

  it('downloads a proxied URL and inlines it as a base64 data URI', async () => {
    resolveMediaBytesMock.mockResolvedValue({
      buffer: Buffer.from('fake-bytes'),
      contentType: 'image/png',
    })
    const rows = [
      {
        sender_type: 'customer',
        content_text: null,
        content_type: 'image',
        media_url: '/api/whatsapp/media/abc123',
      },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', opts)
    const expectedB64 = Buffer.from('fake-bytes').toString('base64')
    expect(out).toEqual([
      {
        role: 'user',
        content: [{ type: 'image', url: `data:image/png;base64,${expectedB64}` }],
      },
    ])
  })

  it('degrades to a placeholder when a proxied image fails to download', async () => {
    resolveMediaBytesMock.mockResolvedValue(null)
    const rows = [
      {
        sender_type: 'customer',
        content_text: null,
        content_type: 'image',
        media_url: '/api/whatsapp/media/abc123',
      },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', opts)
    expect(out).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: '[el cliente envió una imagen que no se pudo cargar]' }],
      },
    ])
  })

  it('only resolves the last 3 images — older ones become a placeholder', async () => {
    // fakeDb mimics the DB's newest-first order (created_at DESC); the fn
    // reverses it to chronological, so row 0 here ends up oldest.
    const rows = Array.from({ length: 5 }, (_, i) => ({
      sender_type: 'customer',
      content_text: null,
      content_type: 'image',
      media_url: `https://chat-media.example.com/photo-${4 - i}.jpg`,
    }))
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', opts)
    expect(out).toHaveLength(5)
    // Oldest two fall back to a placeholder string.
    expect(out[0]).toEqual({ role: 'user', content: '[imagen anterior]' })
    expect(out[1]).toEqual({ role: 'user', content: '[imagen anterior]' })
    // Last 3 get real image parts.
    expect(out[2].content).toEqual([{ type: 'image', url: 'https://chat-media.example.com/photo-2.jpg' }])
    expect(out[3].content).toEqual([{ type: 'image', url: 'https://chat-media.example.com/photo-3.jpg' }])
    expect(out[4].content).toEqual([{ type: 'image', url: 'https://chat-media.example.com/photo-4.jpg' }])
  })
})

describe('buildConversationContext — audio', () => {
  it('transcribes with the embeddings key and caches the transcript', async () => {
    resolveMediaBytesMock.mockResolvedValue({
      buffer: Buffer.from('audio-bytes'),
      contentType: 'audio/ogg',
    })
    transcribeAudioMock.mockResolvedValue('need it by Friday')
    const rows = [
      {
        id: 'msg-1',
        sender_type: 'customer',
        content_text: null,
        content_type: 'audio',
        media_url: 'https://chat-media.example.com/note.ogg',
      },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', {
      accountId: 'acct-1',
      embeddingsApiKey: 'sk-embed',
    })
    expect(out).toEqual([{ role: 'user', content: '[nota de voz] need it by Friday' }])
    expect(transcribeAudioMock).toHaveBeenCalledWith('sk-embed', {
      buffer: Buffer.from('audio-bytes'),
      contentType: 'audio/ogg',
    })
  })

  it('reuses a cached transcript from content_text without re-calling Whisper', async () => {
    const rows = [
      {
        id: 'msg-1',
        sender_type: 'customer',
        content_text: 'already transcribed',
        content_type: 'audio',
        media_url: 'https://chat-media.example.com/note.ogg',
      },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', {
      accountId: 'acct-1',
      embeddingsApiKey: 'sk-embed',
    })
    expect(out).toEqual([{ role: 'user', content: '[nota de voz] already transcribed' }])
    expect(transcribeAudioMock).not.toHaveBeenCalled()
    expect(resolveMediaBytesMock).not.toHaveBeenCalled()
  })

  it('degrades to a placeholder without an embeddings key', async () => {
    const rows = [
      {
        id: 'msg-1',
        sender_type: 'customer',
        content_text: null,
        content_type: 'audio',
        media_url: 'https://chat-media.example.com/note.ogg',
      },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', {
      accountId: 'acct-1',
      embeddingsApiKey: null,
    })
    expect(out).toEqual([
      { role: 'user', content: '[el cliente envió una nota de voz que no se pudo transcribir]' },
    ])
    expect(transcribeAudioMock).not.toHaveBeenCalled()
  })

  it('degrades to a placeholder when transcription throws', async () => {
    resolveMediaBytesMock.mockResolvedValue({
      buffer: Buffer.from('audio-bytes'),
      contentType: 'audio/ogg',
    })
    transcribeAudioMock.mockRejectedValue(new Error('rate limited'))
    const rows = [
      {
        id: 'msg-1',
        sender_type: 'customer',
        content_text: null,
        content_type: 'audio',
        media_url: 'https://chat-media.example.com/note.ogg',
      },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', {
      accountId: 'acct-1',
      embeddingsApiKey: 'sk-embed',
    })
    expect(out).toEqual([
      { role: 'user', content: '[el cliente envió una nota de voz que no se pudo transcribir]' },
    ])
  })
})

describe('buildConversationContext — documents', () => {
  it('extracts text from a supported document', async () => {
    resolveMediaBytesMock.mockResolvedValue({
      buffer: Buffer.from('pdf-bytes'),
      contentType: 'application/pdf',
    })
    extractTextFromFileMock.mockResolvedValue('Invoice total: $42')
    const rows = [
      {
        sender_type: 'customer',
        content_text: 'invoice.pdf',
        content_type: 'document',
        media_url: 'https://chat-media.example.com/invoice.pdf',
        media_type: 'application/pdf',
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', opts)
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'invoice.pdf' },
          { type: 'document_text', title: 'invoice.pdf', text: 'Invoice total: $42' },
        ],
      },
    ])
  })

  it('falls back to a placeholder for an unsupported extension', async () => {
    const rows = [
      {
        sender_type: 'customer',
        content_text: 'archive.zip',
        content_type: 'document',
        media_url: 'https://chat-media.example.com/archive.zip',
        media_type: 'application/zip',
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', opts)
    expect(out).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'archive.zip' },
          {
            type: 'text',
            text: '[el cliente envió un documento (archive.zip) en un formato no compatible]',
          },
        ],
      },
    ])
    expect(resolveMediaBytesMock).not.toHaveBeenCalled()
  })

  it('never caches extracted text into content_text (re-extracts on every call)', async () => {
    resolveMediaBytesMock.mockResolvedValue({
      buffer: Buffer.from('pdf-bytes'),
      contentType: 'application/pdf',
    })
    extractTextFromFileMock.mockResolvedValue('some text')
    const rows = [
      {
        sender_type: 'customer',
        content_text: 'invoice.pdf',
        content_type: 'document',
        media_url: 'https://chat-media.example.com/invoice.pdf',
        media_type: 'application/pdf',
        created_at: '2026-08-01T00:00:00.000Z',
      },
    ]
    await buildConversationContext(fakeDb(rows), 'conv-1', opts)
    await buildConversationContext(fakeDb(rows), 'conv-1', opts)
    expect(extractTextFromFileMock).toHaveBeenCalledTimes(2)
  })
})

describe('buildConversationContext — combined audio/document cap', () => {
  it('only resolves the most recent audio-or-document message', async () => {
    resolveMediaBytesMock.mockResolvedValue({
      buffer: Buffer.from('pdf-bytes'),
      contentType: 'application/pdf',
    })
    extractTextFromFileMock.mockResolvedValue('recent doc text')
    // fakeDb mimics the DB's newest-first order (created_at DESC): the
    // document row (more recent) comes first here, audio (older) second.
    const rows = [
      {
        sender_type: 'customer',
        content_text: 'recent.pdf',
        content_type: 'document',
        media_url: 'https://chat-media.example.com/recent.pdf',
        media_type: 'application/pdf',
        created_at: '2026-08-01T00:00:00.000Z',
      },
      {
        id: 'msg-older',
        sender_type: 'customer',
        content_text: null,
        content_type: 'audio',
        media_url: 'https://chat-media.example.com/older.ogg',
      },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1', {
      accountId: 'acct-1',
      embeddingsApiKey: 'sk-embed',
    })
    expect(out[0]).toEqual({ role: 'user', content: '[nota de voz anterior]' })
    expect(out[1].content).toEqual([
      { type: 'text', text: 'recent.pdf' },
      { type: 'document_text', title: 'recent.pdf', text: 'recent doc text' },
    ])
  })
})
