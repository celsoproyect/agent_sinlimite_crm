import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage, ContentPart } from './types'
import { aiContextMessageLimit } from './defaults'
import { resolveMediaBytes } from './media-resolve'
import { transcribeAudio } from './audio'
import { extractTextFromFile, resolveUploadExt } from './extract-text'
import { mediaFilename } from '@/lib/media/filename'
import { isProxiedMediaUrl } from '@/lib/media/blob-cache'
import type { ContentType } from '@/types'

// Only the last few media items get resolved to real content (image
// bytes/URL, a Whisper transcript, extracted document text) — older ones
// fall back to a cheap text placeholder. Bounds both latency (each real
// resolution is a network call, sometimes two) and cost (every audio
// resolution is a billed Whisper call) regardless of how chatty the
// customer's media history is.
const MAX_RESOLVED_IMAGES = 3
const MAX_RESOLVED_AUDIO_OR_DOCUMENT = 1

// Extracted document text is capped, mirroring the spirit of knowledge-base
// chunking — a full spreadsheet dump would otherwise dominate the context
// window for one message.
const MAX_DOCUMENT_TEXT_CHARS = 4000

interface DbMessage {
  id: string
  sender_type: 'customer' | 'agent' | 'bot'
  content_text: string | null
  content_type: ContentType
  media_url: string | null
  media_type: string | null
  created_at: string
}

/**
 * Fetch the last N messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent and
 * bot messages become `assistant`.
 *
 * Unlike the text-only original, every content type is included — images,
 * voice notes and documents are resolved into real model-readable content
 * (bounded by the caps above), and anything older or unsupported (video,
 * location, stickers-as-image beyond the cap, etc.) still shows up as a
 * short text placeholder rather than being silently dropped, so the model
 * at least knows a message happened there.
 *
 * `accountId` + `embeddingsApiKey` are needed for media resolution: a
 * proxied `media_url` requires the account's WhatsApp access token to
 * re-fetch from Meta, and audio transcription reuses the account's
 * embeddings key (no separate key — same precedent as embeddings.ts).
 *
 * Ordered oldest-first (chronological) so the transcript reads naturally
 * and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  opts: {
    accountId: string
    embeddingsApiKey: string | null
    limit?: number
  },
): Promise<ChatMessage[]> {
  const { accountId, embeddingsApiKey, limit = aiContextMessageLimit() } = opts

  const { data, error } = await db
    .from('messages')
    .select('id, sender_type, content_text, content_type, media_url, media_type, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()

  const imageIdx = new Set(
    rows
      .map((r, i) => (r.content_type === 'image' && r.media_url ? i : -1))
      .filter((i) => i >= 0)
      .slice(-MAX_RESOLVED_IMAGES),
  )
  const mediaIdx = new Set(
    rows
      .map((r, i) => ((r.content_type === 'audio' || r.content_type === 'document') && r.media_url ? i : -1))
      .filter((i) => i >= 0)
      .slice(-MAX_RESOLVED_AUDIO_OR_DOCUMENT),
  )

  const resolved = await Promise.all(
    rows.map((row, i) => resolveRow(db, accountId, embeddingsApiKey, row, imageIdx.has(i), mediaIdx.has(i))),
  )

  return resolved.filter((m): m is ChatMessage => m !== null)
}

async function resolveRow(
  db: SupabaseClient,
  accountId: string,
  embeddingsApiKey: string | null,
  row: DbMessage,
  resolveImage: boolean,
  resolveAudioOrDocument: boolean,
): Promise<ChatMessage | null> {
  const role: ChatMessage['role'] = row.sender_type === 'customer' ? 'user' : 'assistant'
  const caption = row.content_text?.trim() || null

  switch (row.content_type) {
    case 'text':
      return caption ? { role, content: caption } : null

    case 'image':
      if (!row.media_url) return caption ? { role, content: caption } : null
      if (!resolveImage) return { role, content: placeholderWithCaption('[imagen anterior]', caption) }
      return { role, content: await buildImageParts(db, accountId, row.media_url, caption) }

    case 'audio': {
      if (!row.media_url) return null
      if (!resolveAudioOrDocument) return { role, content: '[nota de voz anterior]' }
      const transcript = await resolveAudioTranscript(db, accountId, embeddingsApiKey, row)
      return { role, content: transcript }
    }

    case 'document': {
      if (!row.media_url) return caption ? { role, content: caption } : null
      if (!resolveAudioOrDocument) {
        return { role, content: placeholderWithCaption(`[documento anterior: ${caption ?? 'sin nombre'}]`, null) }
      }
      return { role, content: await buildDocumentParts(db, accountId, row, caption) }
    }

    default:
      // video, location, reaction, interactive, template, ... — no
      // understanding for these yet; keep the turn as a placeholder so
      // the model at least sees something happened, rather than a silent
      // gap in the transcript.
      return caption ? { role, content: caption } : { role, content: `[mensaje de tipo ${row.content_type}]` }
  }
}

function placeholderWithCaption(placeholder: string, caption: string | null): string {
  return caption ? `${placeholder} ${caption}` : placeholder
}

async function buildImageParts(
  db: SupabaseClient,
  accountId: string,
  mediaUrl: string,
  caption: string | null,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = []
  if (caption) parts.push({ type: 'text', text: caption })

  if (!isProxiedMediaUrl(mediaUrl)) {
    parts.push({ type: 'image', url: mediaUrl })
    return parts
  }

  const bytes = await resolveMediaBytes(db, accountId, mediaUrl)
  if (!bytes) {
    parts.push({ type: 'text', text: '[el cliente envió una imagen que no se pudo cargar]' })
    return parts
  }
  const base64 = bytes.buffer.toString('base64')
  parts.push({ type: 'image', url: `data:${bytes.contentType};base64,${base64}` })
  return parts
}

async function resolveAudioTranscript(
  db: SupabaseClient,
  accountId: string,
  embeddingsApiKey: string | null,
  row: DbMessage,
): Promise<string> {
  // Audio never carries a caption (WhatsApp has no caption field for
  // voice notes), so content_text is always empty here — safe to use as
  // a transcript cache. Worth caching specifically because, unlike
  // document extraction, transcription is a billed API call.
  if (row.content_text?.trim()) return `[nota de voz] ${row.content_text.trim()}`
  if (!embeddingsApiKey) return '[el cliente envió una nota de voz que no se pudo transcribir]'

  const bytes = await resolveMediaBytes(db, accountId, row.media_url!)
  if (!bytes) return '[el cliente envió una nota de voz que no se pudo transcribir]'

  try {
    const text = (await transcribeAudio(embeddingsApiKey, bytes)).trim()
    if (!text) return '[el cliente envió una nota de voz que no se pudo transcribir]'
    void db
      .from('messages')
      .update({ content_text: text })
      .eq('id', row.id)
      .then(({ error: cacheErr }: { error: unknown }) => {
        if (cacheErr) console.error('[ai context] transcript cache write failed:', cacheErr)
      })
    return `[nota de voz] ${text}`
  } catch (err) {
    console.error('[ai context] transcription failed:', err)
    return '[el cliente envió una nota de voz que no se pudo transcribir]'
  }
}

async function buildDocumentParts(
  db: SupabaseClient,
  accountId: string,
  row: DbMessage,
  caption: string | null,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = []
  if (caption) parts.push({ type: 'text', text: caption })

  const filename = mediaFilename(
    {
      content_type: row.content_type,
      content_text: row.content_text ?? undefined,
      media_url: row.media_url ?? undefined,
      media_type: row.media_type,
      created_at: row.created_at,
    },
    row.media_type,
  )
  const ext = resolveUploadExt(filename)
  if (!ext) {
    parts.push({ type: 'text', text: `[el cliente envió un documento (${filename}) en un formato no compatible]` })
    return parts
  }

  const bytes = await resolveMediaBytes(db, accountId, row.media_url!)
  if (!bytes) {
    parts.push({ type: 'text', text: `[el cliente envió un documento (${filename}) que no se pudo descargar]` })
    return parts
  }

  try {
    const text = (await extractTextFromFile(bytes.buffer, ext)).slice(0, MAX_DOCUMENT_TEXT_CHARS)
    if (!text.trim()) {
      parts.push({ type: 'text', text: `[el cliente envió un documento (${filename}) sin texto legible]` })
      return parts
    }
    parts.push({ type: 'document_text', title: filename, text })
    return parts
  } catch (err) {
    console.error('[ai context] document extraction failed:', err)
    parts.push({ type: 'text', text: `[el cliente envió un documento (${filename}) que no se pudo leer]` })
    return parts
  }
}
