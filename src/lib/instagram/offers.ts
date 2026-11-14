import type { SupabaseClient } from '@supabase/supabase-js'
import { businessToday } from '@/lib/business-timezone'
import { accountModuleEnabled } from '@/lib/modules-server'

// ============================================================
// Phase 3 (module `instagram_offers`, migration 082): every post or reel
// can carry an offer — text, link, a catalog item, a file and the last
// business day it is valid. When a customer arrives from that post (a
// comment DM, a shared post or reel, a story reply to it), the DM agent
// gets the offer in its prompt, so it knows which one they mean.
// ============================================================

export interface PostOffer {
  text: string | null
  linkUrl: string | null
  catalogItemName: string | null
  mediaUrl: string | null
  mediaName: string | null
  /** Business-local date (YYYY-MM-DD), inclusive; null = no expiry. */
  expiresOn: string | null
}

export interface OfferRow {
  offer_text?: string | null
  offer_link_url?: string | null
  offer_catalog_item_id?: string | null
  offer_media_url?: string | null
  offer_media_name?: string | null
  offer_expires_on?: string | null
}

/** Whether a row carries any offer at all. Pure. */
export function hasOffer(row: OfferRow): boolean {
  return !!(row.offer_text?.trim() || row.offer_link_url || row.offer_catalog_item_id || row.offer_media_url)
}

/** An offer whose last day has passed. `today` is business-local. Pure. */
export function offerExpired(expiresOn: string | null | undefined, today: string): boolean {
  return !!expiresOn && expiresOn < today
}

/** The lines the prompts add for an offer. Pure. */
export function offerPromptLines(offer: PostOffer): string[] {
  const lines = ['The business has this offer on that post:']
  if (offer.text) lines.push(offer.text.slice(0, 1500))
  if (offer.catalogItemName) lines.push(`Catalog item of the offer: "${offer.catalogItemName}" (send it with send_attachment when they want to see it).`)
  if (offer.linkUrl) lines.push(`Link of the offer: ${offer.linkUrl}`)
  if (offer.mediaUrl) lines.push(`File of the offer${offer.mediaName ? ` ("${offer.mediaName}")` : ''}: ${offer.mediaUrl}`)
  if (offer.expiresOn) lines.push(`Valid until ${offer.expiresOn} (inclusive).`)
  return lines
}

/** The block for the DM agent's system prompt. Pure. */
export function formatOfferForAgent(post: { caption: string | null; kind: string }, offer: PostOffer): string {
  const caption = (post.caption ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  return [
    `This customer came from your Instagram ${post.kind}${caption ? ` «${caption}»` : ''}. When they ask about "this", "the offer", "the price" or "what I saw", they mean it.`,
    ...offerPromptLines(offer),
    'Answer with this offer first. If it has expired, say so kindly and offer what you have now.',
  ].join('\n')
}

/** Offer columns of a post row → the offer, with the catalog item's name. */
export function toPostOffer(row: OfferRow, catalogItemName: string | null): PostOffer {
  return {
    text: row.offer_text?.trim() || null,
    linkUrl: row.offer_link_url ?? null,
    catalogItemName,
    mediaUrl: row.offer_media_url ?? null,
    mediaName: row.offer_media_name ?? null,
    expiresOn: row.offer_expires_on ?? null,
  }
}

const OFFER_COLUMNS =
  'caption, media_product_type, offer_text, offer_link_url, offer_catalog_item_id, offer_media_url, offer_media_name, offer_expires_on'

/**
 * The offer of a post, or null (no offer, expired, migration 082 not run).
 * `includeExpired` keeps an expired one (the agent then says it ended).
 */
export async function loadPostOffer(
  db: SupabaseClient,
  accountId: string,
  mediaId: string,
  includeExpired = false,
): Promise<{ caption: string | null; kind: string; offer: PostOffer } | null> {
  const { data, error } = await db
    .from('instagram_posts')
    .select(OFFER_COLUMNS)
    .eq('account_id', accountId)
    .eq('media_id', mediaId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as OfferRow & { caption: string | null; media_product_type: string | null }
  if (!hasOffer(row)) return null
  if (!includeExpired && offerExpired(row.offer_expires_on, businessToday())) return null
  let itemName: string | null = null
  if (row.offer_catalog_item_id) {
    const { data: item } = await db
      .from('ai_attachments')
      .select('name')
      .eq('id', row.offer_catalog_item_id)
      .eq('account_id', accountId)
      .maybeSingle()
    itemName = (item?.name as string | undefined) ?? null
  }
  return {
    caption: row.caption,
    kind: row.media_product_type === 'REELS' ? 'reel' : 'post',
    offer: toPostOffer(row, itemName),
  }
}

const SOURCE_TYPES_WITH_POST = new Set(['comment', 'shared_post', 'shared_reel', 'story_reply', 'ad'])

/**
 * The DM agent's offer block for an Instagram conversation, from the post
 * saved on `conversations.source`. Null when there is none or the module
 * is off. Best-effort.
 */
export async function conversationOfferPrompt(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<string | null> {
  try {
    if (!(await accountModuleEnabled(db, accountId, 'instagram_offers'))) return null
    const { data, error } = await db.from('conversations').select('source').eq('id', conversationId).maybeSingle()
    if (error || !data?.source) return null
    const source = data.source as { type?: string; id?: string | null }
    if (!source.type || !SOURCE_TYPES_WITH_POST.has(source.type) || !source.id) return null
    const found = await loadPostOffer(db, accountId, source.id, true)
    if (!found) return null
    const block = formatOfferForAgent(found, found.offer)
    return offerExpired(found.offer.expiresOn, businessToday())
      ? `${block}\nThis offer EXPIRED on ${found.offer.expiresOn}.`
      : block
  } catch (err) {
    console.error('[instagram] loading the post offer failed:', err)
    return null
  }
}
