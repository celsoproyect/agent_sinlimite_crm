import type { SupabaseClient } from '@supabase/supabase-js'
import type { AttachmentMatch } from './providers/shared'

/** One catalog entry, as surfaced to the admin UI/API. */
export interface AttachmentSummary {
  id: string
  name: string
  description: string
  kind: 'image' | 'document'
  mediaUrl: string
  filename: string
  mimeType: string
  updatedAt: string
}

interface AttachmentRow {
  id: string
  name: string
  description: string
  kind: 'image' | 'document'
  media_url: string
  filename: string
  mime_type: string
  updated_at: string
}

function toSummary(row: AttachmentRow): AttachmentSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    mediaUrl: row.media_url,
    filename: row.filename,
    mimeType: row.mime_type,
    updatedAt: row.updated_at,
  }
}

/**
 * List the account's attachment catalog for the admin UI, newest-updated
 * first.
 */
export async function listAttachments(
  db: SupabaseClient,
  accountId: string,
): Promise<AttachmentSummary[]> {
  const { data, error } = await db
    .from('ai_attachments')
    .select('id, name, description, kind, media_url, filename, mime_type, updated_at')
    .eq('account_id', accountId)
    .order('updated_at', { ascending: false })
  if (error || !data) return []
  return (data as AttachmentRow[]).map(toSummary)
}

/**
 * Search the account's attachment catalog by name/description for the
 * `send_attachment` tool — best-effort like knowledge retrieval: any
 * failure degrades to `[]` rather than throwing into the draft/auto-reply
 * path. ILIKE is enough for a short hand-curated catalog; no embeddings.
 */
export async function searchAttachments(
  db: SupabaseClient,
  accountId: string,
  query: string,
  k = 3,
): Promise<AttachmentMatch[]> {
  const q = query.trim()
  if (!q) return []
  try {
    const { data, error } = await db
      .from('ai_attachments')
      .select('name, kind, media_url, filename')
      .eq('account_id', accountId)
      .or(`name.ilike.%${q}%,description.ilike.%${q}%`)
      .limit(k)
    if (error || !data) return []
    return (data as Pick<AttachmentRow, 'name' | 'kind' | 'media_url' | 'filename'>[]).map((row) => ({
      name: row.name,
      kind: row.kind,
      mediaUrl: row.media_url,
      filename: row.filename,
    }))
  } catch (err) {
    console.error('[ai attachments] search failed:', err)
    return []
  }
}

/**
 * Whether the account has at least one attachment in its catalog — cheap
 * indexed COUNT (head, no rows), used to gate `attachmentsAvailable` in
 * the system prompt and to skip offering the `send_attachment` tool
 * entirely when the catalog is empty.
 */
export async function hasAttachments(db: SupabaseClient, accountId: string): Promise<boolean> {
  try {
    const { count, error } = await db
      .from('ai_attachments')
      .select('id', { count: 'exact', head: true })
      .eq('account_id', accountId)
    return !error && !!count && count > 0
  } catch {
    return false
  }
}
