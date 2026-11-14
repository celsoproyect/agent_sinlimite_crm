// ============================================================
// Instagram webhook payloads → plain events. Pure (no DB, no network) so
// the parsing is unit-tested; inbound.ts does the work.
//
// Meta sends `{ object: 'instagram', entry: [{ id, time, messaging, changes }] }`
// where `entry.id` is the connected professional account and each
// `messaging` item is one event: a message (or our own echo), a postback
// (ice breaker / button), a referral (ad, ig.me link), a read receipt or
// a reaction. `changes` carries comments (phase 2).
// ============================================================

export interface InstagramWebhookBody {
  object?: string
  entry?: InstagramWebhookEntry[]
}

export interface InstagramWebhookEntry {
  id: string
  time?: number
  messaging?: RawMessaging[]
  changes?: { field: string; value: unknown }[]
}

interface RawAttachment {
  type?: string
  payload?: { url?: string; title?: string; reel_video_id?: string; id?: string } | null
}

interface RawReferral {
  ref?: string
  source?: string
  type?: string
  ad_id?: string
  ads_context_data?: { ad_title?: string; photo_url?: string; video_url?: string; post_id?: string; product_id?: string }
}

interface RawMessaging {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    is_echo?: boolean
    is_deleted?: boolean
    is_unsupported?: boolean
    attachments?: RawAttachment[]
    quick_reply?: { payload?: string }
    reply_to?: { mid?: string; story?: { id?: string; url?: string } }
    referral?: RawReferral
  }
  postback?: { mid?: string; title?: string; payload?: string; referral?: RawReferral }
  referral?: RawReferral
  read?: { mid?: string }
}

export interface InstagramAttachment {
  type: string
  url: string | null
  title: string | null
  id: string | null
}

/** Where the customer came from, kept on `conversations.source` (migration 078). */
export interface InstagramSource {
  type: 'story_reply' | 'story_mention' | 'shared_post' | 'shared_reel' | 'ad' | 'link' | 'comment'
  id?: string | null
  url?: string | null
  title?: string | null
  ref?: string | null
  at: string
}

export type InstagramEvent =
  | {
      kind: 'message'
      igsid: string
      mid: string
      timestamp: number
      text: string | null
      attachments: InstagramAttachment[]
      quickReplyPayload: string | null
      replyToMid: string | null
      story: { id: string | null; url: string | null } | null
      referral: RawReferral | null
      unsupported: boolean
    }
  | { kind: 'postback'; igsid: string; mid: string; timestamp: number; title: string; payload: string; referral: RawReferral | null }
  | { kind: 'echo'; igsid: string; mid: string; timestamp: number; text: string | null; attachments: InstagramAttachment[] }
  | { kind: 'referral'; igsid: string; timestamp: number; referral: RawReferral }
  | { kind: 'read'; igsid: string; mid: string }

function attachments(raw: RawAttachment[] | undefined): InstagramAttachment[] {
  return (raw ?? []).map((a) => ({
    type: a.type ?? 'unknown',
    url: a.payload?.url ?? null,
    title: a.payload?.title ?? null,
    id: a.payload?.reel_video_id ?? a.payload?.id ?? null,
  }))
}

/**
 * One entry's events, in order. Events about the business itself (the
 * account messaging itself) and deleted messages are dropped.
 */
export function parseInstagramEntry(entry: InstagramWebhookEntry): InstagramEvent[] {
  const out: InstagramEvent[] = []
  for (const m of entry.messaging ?? []) {
    const sender = m.sender?.id ?? ''
    const recipient = m.recipient?.id ?? ''
    const timestamp = typeof m.timestamp === 'number' ? m.timestamp : Date.now()
    if (m.message) {
      const msg = m.message
      if (!msg.mid || msg.is_deleted) continue
      if (msg.is_echo) {
        if (recipient && recipient !== entry.id) {
          out.push({ kind: 'echo', igsid: recipient, mid: msg.mid, timestamp, text: msg.text ?? null, attachments: attachments(msg.attachments) })
        }
        continue
      }
      if (!sender || sender === entry.id) continue
      out.push({
        kind: 'message',
        igsid: sender,
        mid: msg.mid,
        timestamp,
        text: msg.text?.trim() ? msg.text : null,
        attachments: attachments(msg.attachments),
        quickReplyPayload: msg.quick_reply?.payload ?? null,
        replyToMid: msg.reply_to?.mid ?? null,
        story: msg.reply_to?.story ? { id: msg.reply_to.story.id ?? null, url: msg.reply_to.story.url ?? null } : null,
        referral: msg.referral ?? null,
        unsupported: !!msg.is_unsupported,
      })
      continue
    }
    if (!sender || sender === entry.id) continue
    if (m.postback) {
      const mid = m.postback.mid || `postback-${sender}-${timestamp}`
      out.push({
        kind: 'postback',
        igsid: sender,
        mid,
        timestamp,
        title: m.postback.title ?? m.postback.payload ?? '',
        payload: m.postback.payload ?? '',
        referral: m.postback.referral ?? null,
      })
    } else if (m.referral) {
      out.push({ kind: 'referral', igsid: sender, timestamp, referral: m.referral })
    } else if (m.read?.mid) {
      out.push({ kind: 'read', igsid: sender, mid: m.read.mid })
    }
  }
  return out
}

/** A comment on one of the account's posts or reels (`changes`, field `comments`). */
export interface InstagramComment {
  commentId: string
  mediaId: string | null
  mediaProductType: string | null
  parentId: string | null
  igsid: string
  username: string | null
  text: string
  /** Where it was written: a post/reel (incl. ads) or a live video (082). */
  source: 'comment' | 'live'
}

interface RawCommentValue {
  id?: string
  text?: string
  parent_id?: string
  from?: { id?: string; username?: string; self_ig_scoped_id?: string }
  media?: { id?: string; media_product_type?: string }
}

/**
 * The comments in one entry. The account's own comments (its public
 * replies come back as webhooks too) are dropped.
 */
export function parseInstagramComments(
  entry: InstagramWebhookEntry,
  ownUsername?: string | null,
): InstagramComment[] {
  const out: InstagramComment[] = []
  for (const change of entry.changes ?? []) {
    if (change.field !== 'comments' && change.field !== 'live_comments') continue
    const v = (change.value ?? {}) as RawCommentValue
    const from = v.from?.id
    if (!v.id || !from || from === entry.id) continue
    if (ownUsername && v.from?.username && v.from.username.toLowerCase() === ownUsername.toLowerCase()) continue
    out.push({
      commentId: v.id,
      mediaId: v.media?.id ?? null,
      mediaProductType: v.media?.media_product_type ?? null,
      parentId: v.parent_id ?? null,
      igsid: from,
      username: v.from?.username ?? null,
      text: v.text ?? '',
      source: change.field === 'live_comments' ? 'live' : 'comment',
    })
  }
  return out
}

/** A referral (ad click, ig.me link) as a source. */
export function referralSource(ref: RawReferral, at: string): InstagramSource {
  const ad = ref.ads_context_data
  if (ref.source === 'ADS' || ref.ad_id || ad) {
    return {
      type: 'ad',
      id: ref.ad_id ?? ad?.post_id ?? null,
      title: ad?.ad_title ?? null,
      url: ad?.photo_url ?? ad?.video_url ?? null,
      ref: ref.ref ?? null,
      at,
    }
  }
  return { type: 'link', ref: ref.ref ?? null, at }
}

const MEDIA_TYPES: Record<string, 'image' | 'video' | 'audio' | 'document'> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'document',
  animated_image: 'image',
}

export interface InboundPart {
  /** Meta's mid, suffixed for the 2nd+ part of a multi-attachment message. */
  mid: string
  contentType: 'text' | 'image' | 'video' | 'audio' | 'document' | 'interactive'
  contentText: string | null
  /** Instagram CDN URL (expires); mirrored into storage before saving. */
  mediaUrl: string | null
  interactiveReplyId: string | null
}

export interface DescribedInbound {
  parts: InboundPart[]
  source: InstagramSource | null
}

/**
 * What a customer event becomes in the inbox: one row per attachment
 * (the text rides on the first), with a short Spanish note for things the
 * agent can't see (a shared reel, a story reply, an ad) so it knows what
 * the customer is talking about.
 */
export function describeInstagramEvent(
  event: Extract<InstagramEvent, { kind: 'message' | 'postback' }>,
): DescribedInbound {
  const at = new Date(event.timestamp).toISOString()
  if (event.kind === 'postback') {
    return {
      parts: [{ mid: event.mid, contentType: 'interactive', contentText: event.title, mediaUrl: null, interactiveReplyId: event.payload || null }],
      source: event.referral ? referralSource(event.referral, at) : null,
    }
  }

  let source: InstagramSource | null = event.referral ? referralSource(event.referral, at) : null
  const notes: string[] = []
  const media: { type: InboundPart['contentType']; url: string }[] = []

  if (event.story) {
    source = { type: 'story_reply', id: event.story.id, url: event.story.url, at }
    notes.push('[Respondió a tu historia]')
  }
  for (const a of event.attachments) {
    if (a.type === 'ig_reel' || a.type === 'reel') {
      source = { type: 'shared_reel', id: a.id, url: a.url, title: a.title, at }
      notes.push(a.title ? `[Compartió un reel: «${a.title.slice(0, 200)}»]` : '[Compartió un reel]')
    } else if (a.type === 'share' || a.type === 'ig_post') {
      source = { type: 'shared_post', id: a.id, url: a.url, title: a.title, at }
      notes.push(a.title ? `[Compartió una publicación: «${a.title.slice(0, 200)}»]` : '[Compartió una publicación]')
    } else if (a.type === 'story_mention') {
      source = { type: 'story_mention', url: a.url, at }
      notes.push('[Te mencionó en su historia]')
    } else if (MEDIA_TYPES[a.type] && a.url) {
      media.push({ type: MEDIA_TYPES[a.type], url: a.url })
    }
  }
  if (source?.type === 'ad') notes.unshift(source.title ? `[Llegó desde el anuncio «${source.title}»]` : '[Llegó desde un anuncio]')
  if (event.unsupported && !event.text && media.length === 0) notes.push('[Mensaje que Instagram no permite mostrar]')

  const text = [notes.join(' '), event.text ?? ''].filter(Boolean).join(' ').trim() || null
  const parts: InboundPart[] = []
  if (event.quickReplyPayload) {
    parts.push({ mid: event.mid, contentType: 'interactive', contentText: text, mediaUrl: null, interactiveReplyId: event.quickReplyPayload })
  } else if (media.length === 0) {
    if (text) parts.push({ mid: event.mid, contentType: 'text', contentText: text, mediaUrl: null, interactiveReplyId: null })
  } else {
    media.forEach((m, i) => {
      parts.push({
        mid: i === 0 ? event.mid : `${event.mid}#${i}`,
        contentType: m.type,
        contentText: i === 0 ? text : null,
        mediaUrl: m.url,
        interactiveReplyId: null,
      })
    })
  }
  return { parts, source }
}
