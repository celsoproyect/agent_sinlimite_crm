import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { mirrorInboundMedia } from '@/lib/whatsapp/mirror-inbound-media'
import { fetchInstagramUser } from './api'
import type { InstagramConnection } from './connection'
import type { InstagramSource } from './webhook'

// The Instagram customer as a CRM contact + conversation (channel
// 'instagram'), shared by DMs (inbound.ts) and comments (comments.ts).

export interface ContactRow {
  id: string
  name: string | null
  instagram_username: string | null
  avatar_url: string | null
}

export async function findOrCreateContact(
  db: SupabaseClient,
  conn: InstagramConnection,
  igsid: string,
  /** Known handle (a comment carries it) for when the profile can't be read. */
  fallbackUsername: string | null = null,
): Promise<{ contact: ContactRow; created: boolean } | null> {
  const find = async () => {
    const { data, error } = await db
      .from('contacts')
      .select('id, name, instagram_username, avatar_url')
      .eq('account_id', conn.accountId)
      .eq('instagram_id', igsid)
      .maybeSingle()
    if (error) console.error('[instagram] contact lookup failed:', error)
    return (data as ContactRow | null) ?? null
  }

  const existing = await find()
  if (existing) {
    // Keep the handle fresh: people rename their Instagram accounts.
    if (!existing.instagram_username) {
      const profile = await fetchInstagramUser(conn.accessToken, igsid)
      if (profile?.username) {
        await db.from('contacts').update({ instagram_username: profile.username }).eq('id', existing.id)
      }
    }
    return { contact: existing, created: false }
  }

  const profile = await fetchInstagramUser(conn.accessToken, igsid)
  const username = profile?.username || fallbackUsername
  const name = profile?.name || (username ? `@${username}` : 'Cliente de Instagram')
  const avatar = profile?.profilePic
    ? await mirrorUrl(conn.accountId, `avatar-${igsid}`, profile.profilePic, null)
    : null
  const { data, error } = await db
    .from('contacts')
    .insert({
      account_id: conn.accountId,
      user_id: conn.connectedBy,
      phone: '',
      name,
      instagram_id: igsid,
      instagram_username: username ?? null,
      avatar_url: avatar,
    })
    .select('id, name, instagram_username, avatar_url')
    .single()
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await find()
      if (raced) return { contact: raced, created: false }
    }
    console.error('[instagram] creating the contact failed:', error)
    return null
  }
  return { contact: data as ContactRow, created: true }
}

export async function findOrCreateConversation(
  db: SupabaseClient,
  conn: InstagramConnection,
  contactId: string,
): Promise<{ conversation: { id: string; status: string | null }; created: boolean } | null> {
  const find = async () => {
    const { data } = await db
      .from('conversations')
      .select('id, status')
      .eq('account_id', conn.accountId)
      .eq('contact_id', contactId)
      .order('created_at', { ascending: true })
      .limit(1)
    return data?.[0] ?? null
  }
  const existing = await find()
  if (existing) return { conversation: existing, created: false }
  const { data, error } = await db
    .from('conversations')
    .insert({ account_id: conn.accountId, user_id: conn.connectedBy, contact_id: contactId, channel: 'instagram' })
    .select('id, status')
    .single()
  if (error) {
    if (isUniqueViolation(error)) {
      const raced = await find()
      if (raced) return { conversation: raced, created: false }
    }
    console.error('[instagram] creating the conversation failed:', error)
    return null
  }
  return { conversation: data, created: true }
}

/** Instagram CDN links expire; copy the file into `chat-media`. Falls back to the CDN link. */
export async function mirrorUrl(accountId: string, key: string, url: string, timestamp: number | null): Promise<string> {
  const mediaId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  const mirrored = await mirrorInboundMedia({
    storage: supabaseAdmin().storage,
    accountId,
    mediaId,
    downloadUrl: url,
    accessToken: '',
    messageTimestamp: timestamp ? Math.floor(timestamp / 1000) : null,
    download: async ({ downloadUrl }) => {
      const res = await fetch(downloadUrl)
      if (!res.ok) throw new Error(`Instagram media download failed: ${res.status}`)
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get('content-type') || 'application/octet-stream',
      }
    },
  })
  return mirrored ?? url
}

/** Remembers the latest origin (post, reel, story, ad) on the conversation. */
export async function saveSource(db: SupabaseClient, conversationId: string, source: InstagramSource | null): Promise<void> {
  if (!source) return
  const { error } = await db.from('conversations').update({ source }).eq('id', conversationId)
  if (error && error.code !== '42703') console.error('[instagram] saving the source failed:', error)
}
