import type { SupabaseClient } from '@supabase/supabase-js'
import { isProxiedMediaUrl } from '@/lib/media/blob-cache'
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api'
import { decrypt } from '@/lib/whatsapp/encryption'

// ============================================================
// Server-side resolution of a `messages.media_url` to raw bytes, for the
// AI context builder. A `media_url` is one of two things (see
// blob-cache.ts, the browser-side equivalent of this same split):
//
//   - a public `chat-media` bucket URL (mirrored inbound, or anything we
//     sent) — a plain fetch gets the bytes, no WhatsApp credentials
//     needed.
//   - our own auth-gated proxy pointer, `/api/whatsapp/media/<mediaId>`
//     (mirror disabled/failed) — Meta only hands the bytes to a request
//     carrying the account's access token, so this re-derives a fresh
//     download URL via `getMediaUrl` and fetches through `downloadMedia`,
//     the same two calls the proxy route itself makes.
//
// Best-effort: returns null on any failure rather than throwing, so a
// stale/expired proxy pointer degrades the one message to a placeholder
// instead of failing the whole AI reply.
// ============================================================

const PROXY_PREFIX = '/api/whatsapp/media/'

export interface MediaBytes {
  buffer: Buffer
  contentType: string
}

export async function resolveMediaBytes(
  db: SupabaseClient,
  accountId: string,
  mediaUrl: string,
): Promise<MediaBytes | null> {
  if (!isProxiedMediaUrl(mediaUrl)) {
    try {
      const res = await fetch(mediaUrl)
      if (!res.ok) return null
      const arrayBuffer = await res.arrayBuffer()
      return {
        buffer: Buffer.from(arrayBuffer),
        contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      }
    } catch {
      return null
    }
  }

  const mediaId = mediaUrl.slice(PROXY_PREFIX.length)
  if (!mediaId) return null

  try {
    const { data: config } = await db
      .from('whatsapp_config')
      .select('access_token')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!config?.access_token) return null
    const accessToken = decrypt(config.access_token as string)

    const mediaInfo = await getMediaUrl({ mediaId, accessToken })
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    })
    return { buffer, contentType: contentType || mediaInfo.mimeType || 'application/octet-stream' }
  } catch {
    return null
  }
}
