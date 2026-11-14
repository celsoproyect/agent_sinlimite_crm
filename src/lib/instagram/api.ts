// ============================================================
// Instagram API with Instagram Login (graph.instagram.com).
//
// The account connects its Instagram professional account through
// Instagram's own OAuth (no Facebook page needed). Needs the Instagram
// product of the same Meta app WhatsApp uses:
//   INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET  (Instagram → API setup
//     with Instagram login → "Instagram app ID/secret", not the Meta app's)
//   INSTAGRAM_WEBHOOK_VERIFY_TOKEN           (any string, typed in Meta too)
// Redirect URI: <base>/api/integrations/instagram/callback
// Webhook URL:  <base>/api/instagram/webhook
// ============================================================

import { createHmac, timingSafeEqual } from 'node:crypto'
import { appBaseUrl } from '@/lib/google-calendar/oauth'

export const IG_GRAPH_VERSION = 'v23.0'
const GRAPH = `https://graph.instagram.com/${IG_GRAPH_VERSION}`
const AUTH_URL = 'https://www.instagram.com/oauth/authorize'
const TOKEN_URL = 'https://api.instagram.com/oauth/access_token'
const STATE_MAX_AGE_MS = 15 * 60 * 1000

export const INSTAGRAM_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
  'instagram_business_manage_comments',
]

/** Webhook fields the app subscribes the account to. */
export const INSTAGRAM_WEBHOOK_FIELDS = ['messages', 'messaging_postbacks', 'messaging_referral', 'comments', 'live_comments']

export function instagramConfigured(): boolean {
  return !!process.env.INSTAGRAM_APP_ID && !!process.env.INSTAGRAM_APP_SECRET
}

export function instagramRedirectUri(): string {
  return `${appBaseUrl()}/api/integrations/instagram/callback`
}

function sign(payload: string): string {
  return createHmac('sha256', process.env.INSTAGRAM_APP_SECRET ?? '').update(payload).digest('base64url')
}

/** Signed OAuth `state` tying the callback to the account and user that started it. */
export function signInstagramState(accountId: string, userId: string, now: number = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ a: accountId, u: userId, t: now })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function verifyInstagramState(
  state: string | null,
  now: number = Date.now(),
): { accountId: string; userId: string } | null {
  if (!state) return null
  // Instagram appends "#_" to the redirect; a stray suffix must not break it.
  const [payload, rawMac] = state.split('.')
  const mac = rawMac?.replace(/#_$/, '')
  if (!payload || !mac) return null
  const expected = Buffer.from(sign(payload))
  const given = Buffer.from(mac)
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null
  try {
    const { a, u, t } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (typeof a !== 'string' || typeof u !== 'string' || typeof t !== 'number') return null
    if (now - t > STATE_MAX_AGE_MS || t > now + 60_000) return null
    return { accountId: a, userId: u }
  } catch {
    return null
  }
}

export function buildInstagramAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.INSTAGRAM_APP_ID ?? '',
    redirect_uri: instagramRedirectUri(),
    response_type: 'code',
    scope: INSTAGRAM_SCOPES.join(','),
    enable_fb_login: '0',
    state,
  })
  return `${AUTH_URL}?${params.toString()}`
}

export class InstagramApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    readonly subcode?: number,
  ) {
    super(message)
    this.name = 'InstagramApiError'
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json().catch(() => ({}))) as Record<string, unknown>
}

function apiError(res: Response, json: Record<string, unknown>, what: string): InstagramApiError {
  const err = (json.error ?? {}) as { message?: string; code?: number; error_subcode?: number }
  const message = err.message || (json.error_message as string) || `HTTP ${res.status}`
  return new InstagramApiError(`Instagram ${what}: ${message}`, res.status, err.code, err.error_subcode)
}

/** Code → short-lived token (1 hour) → long-lived token (60 days). */
export async function exchangeInstagramCode(code: string): Promise<{ accessToken: string; expiresIn: number | null }> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.INSTAGRAM_APP_ID ?? '',
      client_secret: process.env.INSTAGRAM_APP_SECRET ?? '',
      grant_type: 'authorization_code',
      redirect_uri: instagramRedirectUri(),
      code: code.replace(/#_$/, ''),
    }),
  })
  const json = await readJson(res)
  if (!res.ok) throw apiError(res, json, 'code exchange')
  // Older responses are flat, newer ones wrap it in `data: [ ... ]`.
  const flat = Array.isArray(json.data) ? (json.data[0] as Record<string, unknown>) : json
  const shortToken = flat?.access_token as string | undefined
  if (!shortToken) throw new InstagramApiError('Instagram code exchange: no access token', res.status)

  const longRes = await fetch(
    `https://graph.instagram.com/access_token?${new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: process.env.INSTAGRAM_APP_SECRET ?? '',
      access_token: shortToken,
    })}`,
  )
  const longJson = await readJson(longRes)
  if (!longRes.ok) throw apiError(longRes, longJson, 'long-lived token')
  return {
    accessToken: longJson.access_token as string,
    expiresIn: typeof longJson.expires_in === 'number' ? longJson.expires_in : null,
  }
}

/** Extends a long-lived token another 60 days (it must be ≥24h old and still valid). */
export async function refreshInstagramToken(accessToken: string): Promise<{ accessToken: string; expiresIn: number | null }> {
  const res = await fetch(
    `https://graph.instagram.com/refresh_access_token?${new URLSearchParams({
      grant_type: 'ig_refresh_token',
      access_token: accessToken,
    })}`,
  )
  const json = await readJson(res)
  if (!res.ok) throw apiError(res, json, 'token refresh')
  return {
    accessToken: json.access_token as string,
    expiresIn: typeof json.expires_in === 'number' ? json.expires_in : null,
  }
}

async function graph(
  path: string,
  accessToken: string,
  init: { method?: 'GET' | 'POST' | 'DELETE'; query?: Record<string, string>; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const url = new URL(`${GRAPH}/${path}`)
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v)
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  const json = await readJson(res)
  if (!res.ok) throw apiError(res, json, path)
  return json
}

export interface InstagramProfile {
  /** The professional account id webhooks carry in `entry.id`. */
  igUserId: string
  username: string | null
  name: string | null
  profilePictureUrl: string | null
}

export async function fetchInstagramMe(accessToken: string): Promise<InstagramProfile> {
  const json = await graph('me', accessToken, {
    query: { fields: 'user_id,username,name,profile_picture_url' },
  })
  const igUserId = (json.user_id as string | number | undefined) ?? (json.id as string | undefined)
  if (!igUserId) throw new InstagramApiError('Instagram profile: no user id', 500)
  return {
    igUserId: String(igUserId),
    username: (json.username as string) ?? null,
    name: (json.name as string) ?? null,
    profilePictureUrl: (json.profile_picture_url as string) ?? null,
  }
}

/** Subscribes this app to the account's webhooks (messages, comments…). */
export async function subscribeInstagramWebhooks(accessToken: string): Promise<void> {
  try {
    await graph('me/subscribed_apps', accessToken, {
      method: 'POST',
      query: { subscribed_fields: INSTAGRAM_WEBHOOK_FIELDS.join(',') },
    })
  } catch (err) {
    // An app not yet approved for `live_comments` refuses the whole call:
    // subscribe the rest so DMs and comments keep working.
    console.warn('[instagram] full webhook subscription refused, retrying without live_comments:', err)
    await graph('me/subscribed_apps', accessToken, {
      method: 'POST',
      query: { subscribed_fields: INSTAGRAM_WEBHOOK_FIELDS.filter((f) => f !== 'live_comments').join(',') },
    })
  }
}

export interface InstagramUserProfile {
  name: string | null
  username: string | null
  profilePic: string | null
  followsBusiness: boolean | null
}

/** A customer's public profile. Only works once they have written to the account. */
export async function fetchInstagramUser(accessToken: string, igsid: string): Promise<InstagramUserProfile | null> {
  try {
    const json = await graph(igsid, accessToken, {
      query: { fields: 'name,username,profile_pic,is_user_follow_business' },
    })
    return {
      name: (json.name as string) || null,
      username: (json.username as string) || null,
      profilePic: (json.profile_pic as string) || null,
      followsBusiness: typeof json.is_user_follow_business === 'boolean' ? json.is_user_follow_business : null,
    }
  } catch (err) {
    console.warn('[instagram] user profile lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export type InstagramAttachmentType = 'image' | 'video' | 'audio' | 'file'

export interface InstagramQuickReply {
  title: string
  payload: string
}

export type InstagramOutbound =
  | { kind: 'text'; text: string; quickReplies?: InstagramQuickReply[] }
  | { kind: 'attachment'; type: InstagramAttachmentType; url: string }

/** Sends one DM. Returns Meta's message id (`mid`). */
export async function sendInstagramMessage(
  accessToken: string,
  recipient: { id: string } | { comment_id: string },
  message: InstagramOutbound,
): Promise<string> {
  const body =
    message.kind === 'text'
      ? {
          recipient,
          message: {
            text: message.text,
            ...(message.quickReplies?.length
              ? {
                  quick_replies: message.quickReplies.slice(0, 13).map((q) => ({
                    content_type: 'text',
                    title: q.title.slice(0, 20),
                    payload: q.payload,
                  })),
                }
              : {}),
          },
        }
      : { recipient, message: { attachment: { type: message.type, payload: { url: message.url } } } }
  const json = await graph('me/messages', accessToken, { method: 'POST', body })
  return String(json.message_id ?? '')
}

/** "Seen" or "typing…" on the customer's side. Best-effort, never throws. */
export async function sendInstagramSenderAction(
  accessToken: string,
  igsid: string,
  action: 'mark_seen' | 'typing_on' | 'typing_off',
): Promise<void> {
  try {
    await graph('me/messages', accessToken, {
      method: 'POST',
      body: { recipient: { id: igsid }, sender_action: action },
    })
  } catch (err) {
    console.warn(`[instagram] ${action} failed:`, err instanceof Error ? err.message : err)
  }
}

// ---- Phase 2: posts and comments ----------------------------------

export interface InstagramMedia {
  id: string
  caption: string | null
  mediaType: string | null
  mediaProductType: string | null
  permalink: string | null
  mediaUrl: string | null
  thumbnailUrl: string | null
  timestamp: string | null
}

const MEDIA_FIELDS = 'id,caption,media_type,media_product_type,permalink,media_url,thumbnail_url,timestamp'

function toMedia(raw: Record<string, unknown>): InstagramMedia {
  return {
    id: String(raw.id),
    caption: (raw.caption as string) ?? null,
    mediaType: (raw.media_type as string) ?? null,
    mediaProductType: (raw.media_product_type as string) ?? null,
    permalink: (raw.permalink as string) ?? null,
    mediaUrl: (raw.media_url as string) ?? null,
    thumbnailUrl: (raw.thumbnail_url as string) ?? null,
    timestamp: (raw.timestamp as string) ?? null,
  }
}

/** The account's latest posts and reels, newest first (up to `max`). */
export async function listInstagramMedia(accessToken: string, max = 100): Promise<InstagramMedia[]> {
  const out: InstagramMedia[] = []
  let after: string | null = null
  while (out.length < max) {
    const query: Record<string, string> = { fields: MEDIA_FIELDS, limit: String(Math.min(50, max - out.length)) }
    if (after) query.after = after
    const json = await graph('me/media', accessToken, { query })
    const data = (json.data as Record<string, unknown>[] | undefined) ?? []
    out.push(...data.map(toMedia))
    const paging = json.paging as { cursors?: { after?: string }; next?: string } | undefined
    after = paging?.next ? (paging.cursors?.after ?? null) : null
    if (!after || data.length === 0) break
  }
  return out
}

/** One post or reel by id, or null when it can't be read. */
export async function fetchInstagramMedia(accessToken: string, mediaId: string): Promise<InstagramMedia | null> {
  try {
    return toMedia(await graph(mediaId, accessToken, { query: { fields: MEDIA_FIELDS } }))
  } catch (err) {
    console.warn('[instagram] media lookup failed:', err instanceof Error ? err.message : err)
    return null
  }
}

/** A public reply under a comment. Returns the new comment's id. */
export async function replyToInstagramComment(accessToken: string, commentId: string, message: string): Promise<string> {
  const json = await graph(`${commentId}/replies`, accessToken, { method: 'POST', query: { message } })
  return String(json.id ?? '')
}

/**
 * The one private DM Meta allows per comment (within 7 days of it). The
 * reply lands in the customer's message requests; once they answer, the
 * 24h window is open like any DM. Returns the message id and the
 * customer's IGSID.
 */
export async function sendInstagramPrivateReply(
  accessToken: string,
  commentId: string,
  message: Extract<InstagramOutbound, { kind: 'text' }>,
): Promise<{ mid: string; recipientId: string | null }> {
  const body = {
    recipient: { comment_id: commentId },
    message: {
      text: message.text,
      ...(message.quickReplies?.length
        ? {
            quick_replies: message.quickReplies.slice(0, 13).map((q) => ({
              content_type: 'text',
              title: q.title.slice(0, 20),
              payload: q.payload,
            })),
          }
        : {}),
    },
  }
  const json = await graph('me/messages', accessToken, { method: 'POST', body })
  return { mid: String(json.message_id ?? ''), recipientId: (json.recipient_id as string) ?? null }
}

/** Hides (or shows again) a comment on the account's post. */
export async function hideInstagramComment(accessToken: string, commentId: string, hide = true): Promise<void> {
  await graph(commentId, accessToken, { method: 'POST', query: { hide: hide ? 'true' : 'false' } })
}

// ---- Phase 4: ice breakers and the persistent menu ----------------

export interface MessengerProfileInput {
  iceBreakers: { question: string; payload: string }[]
  menu: ({ title: string; payload: string } | { title: string; url: string })[]
}

/** The Messenger Profile body for Instagram. Pure. */
export function messengerProfileBody(input: MessengerProfileInput): Record<string, unknown> {
  const body: Record<string, unknown> = { platform: 'instagram' }
  if (input.iceBreakers.length) {
    body.ice_breakers = [
      {
        locale: 'default',
        call_to_actions: input.iceBreakers.slice(0, 4).map((b) => ({ question: b.question.slice(0, 80), payload: b.payload })),
      },
    ]
  }
  if (input.menu.length) {
    body.persistent_menu = [
      {
        locale: 'default',
        composer_input_disabled: false,
        call_to_actions: input.menu.slice(0, 5).map((m) =>
          'url' in m
            ? { type: 'web_url', title: m.title.slice(0, 30), url: m.url }
            : { type: 'postback', title: m.title.slice(0, 30), payload: m.payload },
        ),
      },
    ]
  }
  return body
}

/**
 * Pushes the ice breakers and menu. Empty lists are deleted on Instagram,
 * so removing every item in the CRM removes them in the app too.
 */
export async function setInstagramMessengerProfile(accessToken: string, input: MessengerProfileInput): Promise<void> {
  const remove: string[] = []
  if (!input.iceBreakers.length) remove.push('ice_breakers')
  if (!input.menu.length) remove.push('persistent_menu')
  if (remove.length) {
    await graph('me/messenger_profile', accessToken, {
      method: 'DELETE',
      body: { platform: 'instagram', fields: remove },
    })
  }
  if (input.iceBreakers.length || input.menu.length) {
    await graph('me/messenger_profile', accessToken, { method: 'POST', body: messengerProfileBody(input) })
  }
}
