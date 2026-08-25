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
  price?: number
  currency?: string
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
  price: number | null
  currency: string | null
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
    price: row.price ?? undefined,
    currency: row.currency ?? undefined,
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
    .select('id, name, description, kind, media_url, filename, mime_type, price, currency, updated_at')
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
      .select('name, description, kind, media_url, filename, price, currency')
      .eq('account_id', accountId)
      .or(`name.ilike.%${q}%,description.ilike.%${q}%`)
      .limit(k)
    if (error || !data) return []
    return (
      data as Pick<
        AttachmentRow,
        'name' | 'description' | 'kind' | 'media_url' | 'filename' | 'price' | 'currency'
      >[]
    ).map((row) => ({
      name: row.name,
      description: row.description || undefined,
      kind: row.kind,
      mediaUrl: row.media_url,
      filename: row.filename,
      price: row.price ?? undefined,
      currency: row.currency ?? undefined,
    }))
  } catch (err) {
    console.error('[ai attachments] search failed:', err)
    return []
  }
}

/** One catalog name, as surfaced to the model up front so it can name
 *  what's available without a tool call — e.g. answering "what services
 *  do you offer?" by listing names and asking which one the customer
 *  wants to see, before calling `send_attachment` for the full card. */
export interface AttachmentRosterEntry {
  name: string
  kind: 'image' | 'document'
}

/**
 * List the account's catalog names (cheap, indexed) for the system
 * prompt roster, and to gate `attachmentsAvailable`/the `send_attachment`
 * tool — both replace the old `hasAttachments` boolean-only check, since
 * the roster is the same query with one more (still cheap) column.
 * Best-effort: any failure degrades to `[]`, same as `searchAttachments`.
 */
export async function getAttachmentRoster(
  db: SupabaseClient,
  accountId: string,
): Promise<AttachmentRosterEntry[]> {
  try {
    const { data, error } = await db
      .from('ai_attachments')
      .select('name, kind')
      .eq('account_id', accountId)
      .order('name', { ascending: true })
    if (error || !data) return []
    return data as AttachmentRosterEntry[]
  } catch (err) {
    console.error('[ai attachments] roster failed:', err)
    return []
  }
}
