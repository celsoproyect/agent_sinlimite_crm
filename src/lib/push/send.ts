import type { SupabaseClient } from '@supabase/supabase-js'
import webpush from 'web-push'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { accountModuleEnabled } from '@/lib/modules-server'
import type { AccountRole } from '@/lib/auth/roles'

/**
 * Web Push sender (module `web_push`, migration 071).
 *
 * Every send is best-effort: it never throws, it is a no-op when the
 * VAPID keys are missing or the module is off, and subscriptions the
 * push service reports as gone (404/410) are deleted.
 */

export interface PushPayload {
  title: string
  body: string
  /** Path the notification opens, e.g. `/inbox?c=<id>`. */
  url?: string
  /** Same tag = the new notification replaces the previous one. */
  tag?: string
}

export interface PushResult {
  sent: number
  failed: number
}

const DEFAULT_SUBJECT = 'mailto:soporte@agentesinlimite.com'
const NOTHING: PushResult = { sent: 0, failed: 0 }

/** The VAPID public key the browser subscribes with, or null when push
 *  isn't configured. Served by `GET /api/push/public-key` (not a
 *  NEXT_PUBLIC var, which the Docker image would bake at build time). */
export function vapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY?.trim() || null
}

let appliedVapid: string | null = null

/** Configure web-push from the env. False when keys are missing or invalid. */
function ensureVapid(): boolean {
  const publicKey = vapidPublicKey()
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim()
  if (!publicKey || !privateKey) return false
  const subject = process.env.VAPID_SUBJECT?.trim() || DEFAULT_SUBJECT
  const signature = `${subject}|${publicKey}|${privateKey}`
  if (appliedVapid === signature) return true
  try {
    webpush.setVapidDetails(subject, publicKey, privateKey)
    appliedVapid = signature
    return true
  } catch (err) {
    console.error('[push] invalid VAPID configuration:', err)
    return false
  }
}

export function pushConfigured(): boolean {
  return ensureVapid()
}

interface SubscriptionRow {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

/** Send to every device of the given users in the account. */
export async function sendPushToUsers(
  accountId: string,
  userIds: string[],
  payload: PushPayload,
  db: SupabaseClient = supabaseAdmin(),
): Promise<PushResult> {
  // Env check first: no keys = no DB round-trips at all.
  if (!userIds.length || !ensureVapid()) return NOTHING
  try {
    if (!(await accountModuleEnabled(db, accountId, 'web_push'))) return NOTHING

    const { data, error } = await db
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('account_id', accountId)
      .in('user_id', userIds)
    if (error) {
      // 42P01 / PGRST205: migration 071 hasn't run yet.
      if (error.code !== '42P01' && error.code !== 'PGRST205') {
        console.error('[push] subscription lookup failed:', error)
      }
      return NOTHING
    }
    const subs = (data ?? []) as SubscriptionRow[]
    if (!subs.length) return NOTHING

    const body = JSON.stringify(payload)
    const gone: string[] = []
    const delivered: string[] = []
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            body,
            { TTL: 60 * 60 * 24, urgency: 'high' },
          )
          delivered.push(sub.id)
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) gone.push(sub.id)
          else console.error('[push] send failed:', status ?? err)
        }
      }),
    )

    if (gone.length) {
      const { error: delErr } = await db.from('push_subscriptions').delete().in('id', gone)
      if (delErr) console.error('[push] stale subscription cleanup failed:', delErr)
    }
    if (delivered.length) {
      await db
        .from('push_subscriptions')
        .update({ last_used_at: new Date().toISOString() })
        .in('id', delivered)
    }
    return { sent: delivered.length, failed: subs.length - delivered.length }
  } catch (err) {
    console.error('[push] send to users failed:', err)
    return NOTHING
  }
}

/** Send to every user of the account with one of the given roles. */
export async function sendPushToAccountRoles(
  accountId: string,
  roles: AccountRole[],
  payload: PushPayload,
  db: SupabaseClient = supabaseAdmin(),
): Promise<PushResult> {
  if (!roles.length || !ensureVapid()) return NOTHING
  try {
    const { data, error } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .in('account_role', roles)
    if (error || !data?.length) return NOTHING
    return sendPushToUsers(
      accountId,
      data.map((p: { user_id: string }) => p.user_id),
      payload,
      db,
    )
  } catch (err) {
    console.error('[push] send to roles failed:', err)
    return NOTHING
  }
}

/** Trim a notification body to roughly `max` characters on a word boundary. */
export function trimPushBody(text: string, max = 180): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}
