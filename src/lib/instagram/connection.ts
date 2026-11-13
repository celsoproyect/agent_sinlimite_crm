import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { refreshInstagramToken } from './api'

// The Instagram account an account connected (migration 078). Read only
// with the service role: the table has RLS on and no policies.

export interface InstagramConnection {
  accountId: string
  igUserId: string
  username: string | null
  name: string | null
  profilePictureUrl: string | null
  accessToken: string
  tokenExpiresAt: string | null
  aiEnabled: boolean
  connectedBy: string | null
}

interface ConnectionRow {
  account_id: string
  ig_user_id: string
  username: string | null
  name: string | null
  profile_picture_url: string | null
  access_token: string
  token_expires_at: string | null
  token_refreshed_at: string | null
  ai_enabled: boolean
  connected_by: string | null
  updated_at: string
}

const COLUMNS =
  'account_id, ig_user_id, username, name, profile_picture_url, access_token, token_expires_at, token_refreshed_at, ai_enabled, connected_by, updated_at'

/** Postgres/PostgREST "relation does not exist": migration 078 not run yet. */
export function isMissingTable(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42P01' || error?.code === 'PGRST205'
}

function toConnection(row: ConnectionRow): InstagramConnection | null {
  try {
    return {
      accountId: row.account_id,
      igUserId: row.ig_user_id,
      username: row.username,
      name: row.name,
      profilePictureUrl: row.profile_picture_url,
      accessToken: decrypt(row.access_token),
      tokenExpiresAt: row.token_expires_at,
      aiEnabled: row.ai_enabled,
      connectedBy: row.connected_by,
    }
  } catch (err) {
    console.error('[instagram] could not decrypt the access token:', err)
    return null
  }
}

export async function loadInstagramConnection(
  db: SupabaseClient,
  accountId: string,
): Promise<InstagramConnection | null> {
  const { data, error } = await db.from('instagram_connections').select(COLUMNS).eq('account_id', accountId).maybeSingle()
  if (error) {
    if (!isMissingTable(error)) console.error('[instagram] loading the connection failed:', error)
    return null
  }
  return data ? toConnection(data as ConnectionRow) : null
}

/** The connection a webhook belongs to, by `entry.id`. */
export async function findInstagramConnectionByIgUser(
  db: SupabaseClient,
  igUserId: string,
): Promise<InstagramConnection | null> {
  const { data, error } = await db.from('instagram_connections').select(COLUMNS).eq('ig_user_id', igUserId).maybeSingle()
  if (error) {
    if (!isMissingTable(error)) console.error('[instagram] connection lookup failed:', error)
    return null
  }
  return data ? toConnection(data as ConnectionRow) : null
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Refresh once the token has less than this left. */
const REFRESH_WINDOW_MS = 15 * DAY_MS

/**
 * Long-lived Instagram tokens last 60 days and can be extended once they
 * are at least a day old. Runs from the schedulers; refreshes every token
 * within 15 days of expiring.
 */
export async function refreshExpiringInstagramTokens(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from('instagram_connections')
    .select(COLUMNS)
    .lt('token_expires_at', new Date(now.getTime() + REFRESH_WINDOW_MS).toISOString())
  if (error) {
    if (!isMissingTable(error)) console.error('[instagram] token refresh query failed:', error)
    return 0
  }
  let refreshed = 0
  for (const row of (data ?? []) as ConnectionRow[]) {
    const lastChange = new Date(row.token_refreshed_at ?? row.updated_at).getTime()
    if (now.getTime() - lastChange < DAY_MS) continue
    const conn = toConnection(row)
    if (!conn) continue
    try {
      const next = await refreshInstagramToken(conn.accessToken)
      const { error: upErr } = await db
        .from('instagram_connections')
        .update({
          access_token: encrypt(next.accessToken),
          token_expires_at: next.expiresIn ? new Date(now.getTime() + next.expiresIn * 1000).toISOString() : null,
          token_refreshed_at: now.toISOString(),
          updated_at: now.toISOString(),
        })
        .eq('account_id', row.account_id)
      if (upErr) throw upErr
      refreshed++
    } catch (err) {
      console.error(`[instagram] token refresh failed for account ${row.account_id}:`, err)
    }
  }
  return refreshed
}
