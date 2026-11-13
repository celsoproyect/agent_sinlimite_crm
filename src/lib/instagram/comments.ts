import type { SupabaseClient } from '@supabase/supabase-js'
import { accountModuleEnabled } from '@/lib/modules-server'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'
import {
  fetchInstagramMedia,
  listInstagramMedia,
  replyToInstagramComment,
  sendInstagramPrivateReply,
  type InstagramMedia,
} from './api'
import type { InstagramConnection } from './connection'
import { isMissingTable } from './connection'
import { findOrCreateContact, findOrCreateConversation, saveSource } from './contacts'
import { toInstagramText } from './format'
import {
  pickPublicReply,
  pickRule,
  ruleButtonPayload,
  ruleContentText,
  type KeywordRule,
} from './keywords'
import { instagramEngineSendMedia, instagramEngineSendText, rememberSentMid } from './send'
import type { InstagramComment } from './webhook'

// ============================================================
// Instagram comments (phase 2, migration 079, feature module
// `instagram_comments`). A comment that fires a keyword rule gets the
// rule's public reply and its one private DM; every comment is logged in
// `instagram_comments` with what happened. The DM opens a conversation
// in the inbox, so the customer's answer reaches the AI agent like any
// Instagram DM.
// ============================================================

/** Opening text when a rule has a button but no opening of its own. */
export const DEFAULT_DM_OPENING = '¡Hola! 👋 Gracias por tu comentario. Toca el botón y te envío la información por aquí.'
/** Meta allows a private reply up to 7 days after the comment. */
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const RULE_COLUMNS =
  'id, media_id, name, keywords, match_any, public_replies, dm_opening, dm_button_label, dm_text, dm_link_url, catalog_item_id, tag_id, once_per_user, active, created_at, updated_at'

export interface PostRow {
  media_id: string
  caption: string | null
  media_type: string | null
  media_product_type: string | null
  permalink: string | null
  media_url: string | null
  thumbnail_url: string | null
  posted_at: string | null
}

function postRow(accountId: string, m: InstagramMedia, now: string) {
  return {
    account_id: accountId,
    media_id: m.id,
    caption: m.caption,
    media_type: m.mediaType,
    media_product_type: m.mediaProductType,
    permalink: m.permalink,
    media_url: m.mediaUrl,
    thumbnail_url: m.thumbnailUrl,
    posted_at: m.timestamp,
    synced_at: now,
  }
}

/** Pulls the latest posts and reels into `instagram_posts`. Returns how many. */
export async function syncInstagramPosts(db: SupabaseClient, conn: InstagramConnection): Promise<number> {
  const media = await listInstagramMedia(conn.accessToken)
  if (media.length === 0) return 0
  const now = new Date().toISOString()
  const { error } = await db
    .from('instagram_posts')
    .upsert(media.map((m) => postRow(conn.accountId, m, now)), { onConflict: 'account_id,media_id' })
  if (error) throw new Error(error.message)
  return media.length
}

/** The post a comment is on, fetched and saved the first time it's seen. */
async function ensurePost(db: SupabaseClient, conn: InstagramConnection, mediaId: string): Promise<PostRow | null> {
  const { data } = await db
    .from('instagram_posts')
    .select('media_id, caption, media_type, media_product_type, permalink, media_url, thumbnail_url, posted_at')
    .eq('account_id', conn.accountId)
    .eq('media_id', mediaId)
    .maybeSingle()
  if (data) return data as PostRow
  const media = await fetchInstagramMedia(conn.accessToken, mediaId)
  if (!media) return null
  const row = postRow(conn.accountId, media, new Date().toISOString())
  await db.from('instagram_posts').upsert(row, { onConflict: 'account_id,media_id' })
  return row
}

export async function loadKeywordRules(db: SupabaseClient, accountId: string): Promise<KeywordRule[]> {
  const { data, error } = await db.from('instagram_keyword_rules').select(RULE_COLUMNS).eq('account_id', accountId)
  if (error) {
    if (!isMissingTable(error)) console.error('[instagram] loading keyword rules failed:', error)
    return []
  }
  return (data ?? []) as KeywordRule[]
}

async function updateComment(db: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db
    .from('instagram_comments')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) console.error('[instagram] updating the comment log failed:', error)
}

/** Every comment of one webhook entry. */
export async function processInstagramComments(
  db: SupabaseClient,
  conn: InstagramConnection,
  comments: InstagramComment[],
): Promise<void> {
  if (comments.length === 0) return
  if (!(await accountModuleEnabled(db, conn.accountId, 'instagram_comments'))) return
  for (const comment of comments) {
    try {
      await processComment(db, conn, comment)
    } catch (err) {
      console.error('[instagram] comment failed:', comment.commentId, err)
    }
  }
}

async function processComment(db: SupabaseClient, conn: InstagramConnection, comment: InstagramComment): Promise<void> {
  // Claim the comment: a redelivered webhook conflicts here and stops.
  const { data: claimed, error: claimErr } = await db
    .from('instagram_comments')
    .insert({
      account_id: conn.accountId,
      comment_id: comment.commentId,
      media_id: comment.mediaId,
      parent_id: comment.parentId,
      igsid: comment.igsid,
      username: comment.username,
      text: comment.text,
    })
    .select('id')
    .single()
  if (claimErr) {
    if (claimErr.code !== '23505' && !isMissingTable(claimErr)) console.error('[instagram] logging the comment failed:', claimErr)
    return
  }
  const logId = claimed.id as string

  const post = comment.mediaId ? await ensurePost(db, conn, comment.mediaId).catch(() => null) : null
  const rules = await loadKeywordRules(db, conn.accountId)
  const hit = pickRule(rules, { mediaId: comment.mediaId, text: comment.text })
  if (!hit) {
    await updateComment(db, logId, { status: 'no_match' })
    return
  }
  const { rule, keyword } = hit
  const patch: Record<string, unknown> = { rule_id: rule.id, status: 'replied' }

  // 1. Public reply under the comment (rotating versions).
  const publicText = pickPublicReply(rule.public_replies, comment.username)
  if (publicText) {
    try {
      patch.public_reply_id = await replyToInstagramComment(conn.accessToken, comment.commentId, publicText)
      patch.public_reply_text = publicText
    } catch (err) {
      patch.dm_error = `Respuesta pública: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // 2. The private DM, once per person per rule unless the rule allows repeats.
  if (rule.once_per_user && (await alreadyMessaged(db, conn.accountId, rule.id, comment.igsid, logId))) {
    patch.dm_status = 'repeat'
  } else {
    const dm = await sendRuleDm(db, conn, rule, {
      commentId: comment.commentId,
      igsid: comment.igsid,
      username: comment.username,
      post,
      keyword,
    })
    Object.assign(patch, dm)
  }
  await updateComment(db, logId, patch)
}

async function alreadyMessaged(
  db: SupabaseClient,
  accountId: string,
  ruleId: string,
  igsid: string,
  exceptId: string,
): Promise<boolean> {
  const { data } = await db
    .from('instagram_comments')
    .select('id')
    .eq('account_id', accountId)
    .eq('rule_id', ruleId)
    .eq('igsid', igsid)
    .in('dm_status', ['sent', 'awaiting_tap', 'delivered'])
    .neq('id', exceptId)
    .limit(1)
  return (data?.length ?? 0) > 0
}

/** What a rule's DM looks like as the comment's private reply. */
export function privateReplyFor(
  rule: Pick<KeywordRule, 'id' | 'dm_opening' | 'dm_button_label' | 'dm_text' | 'dm_link_url' | 'catalog_item_id'>,
): { text: string; button: { title: string; payload: string } | null } | null {
  const button = rule.dm_button_label?.trim()
  if (button) {
    return {
      text: rule.dm_opening?.trim() || DEFAULT_DM_OPENING,
      button: { title: button, payload: ruleButtonPayload(rule.id) },
    }
  }
  const content = ruleContentText(rule)
  return content ? { text: content, button: null } : null
}

/**
 * Sends the rule's private reply and opens the conversation in the inbox.
 * Returns the comment-log fields to save.
 */
async function sendRuleDm(
  db: SupabaseClient,
  conn: InstagramConnection,
  rule: KeywordRule,
  ctx: { commentId: string; igsid: string; username: string | null; post: PostRow | null; keyword: string | null },
): Promise<Record<string, unknown>> {
  const reply = privateReplyFor(rule)
  if (!reply) return {}

  let sentText = toInstagramText(reply.text)
  let status: 'sent' | 'awaiting_tap' = reply.button ? 'awaiting_tap' : 'sent'
  let result: { mid: string; recipientId: string | null }
  try {
    result = await sendInstagramPrivateReply(conn.accessToken, ctx.commentId, {
      kind: 'text',
      text: sentText.slice(0, 1000),
      quickReplies: reply.button ? [reply.button] : undefined,
    })
  } catch (err) {
    // A button that Meta refuses: send the content itself instead.
    const content = toInstagramText(ruleContentText(rule))
    if (!reply.button || !content) return { dm_status: 'failed', dm_error: err instanceof Error ? err.message : String(err) }
    try {
      result = await sendInstagramPrivateReply(conn.accessToken, ctx.commentId, { kind: 'text', text: content.slice(0, 1000) })
      sentText = content
      status = 'sent'
    } catch (err2) {
      return { dm_status: 'failed', dm_error: err2 instanceof Error ? err2.message : String(err2) }
    }
  }
  rememberSentMid(result.mid)

  // The conversation in the inbox, with where it came from.
  const igsid = result.recipientId || ctx.igsid
  const contactOutcome = await findOrCreateContact(db, conn, igsid, ctx.username)
  if (!contactOutcome) return { dm_status: status }
  const contactId = contactOutcome.contact.id
  const convResult = await findOrCreateConversation(db, conn, contactId)
  const conversationId = convResult?.conversation.id ?? null
  if (conversationId) {
    await saveSource(db, conversationId, {
      type: 'comment',
      id: ctx.post?.media_id ?? null,
      url: ctx.post?.permalink ?? null,
      title: ctx.post?.caption ? ctx.post.caption.slice(0, 200) : null,
      ref: ctx.keyword,
      at: new Date().toISOString(),
    })
    const now = new Date().toISOString()
    await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      status: 'sent',
      content_type: reply.button && status === 'awaiting_tap' ? 'interactive' : 'text',
      content_text: sentText,
      message_id: result.mid || null,
      ...(reply.button && status === 'awaiting_tap'
        ? { interactive_payload: { kind: 'buttons', body: sentText, buttons: [{ id: reply.button.payload, title: reply.button.title }] } }
        : {}),
    })
    await db
      .from('conversations')
      .update({ last_message_text: sentText, last_message_at: now, updated_at: now })
      .eq('id', conversationId)
  }

  if (rule.tag_id) {
    await addContactTagAndDispatch({
      db,
      accountId: conn.accountId,
      contactId,
      tagId: rule.tag_id,
      context: conversationId ? { conversation_id: conversationId } : {},
    }).catch((err) => console.error('[instagram] tagging the commenter failed:', err))
  }

  return { dm_status: status, contact_id: contactId, conversation_id: conversationId }
}

/**
 * The customer tapped a rule's button (or answered its opening message):
 * the window is open, so the content goes now — the catalog item first,
 * then the text and link. Returns true when something was delivered.
 */
export async function deliverPendingRuleContent(
  db: SupabaseClient,
  args: {
    accountId: string
    igsid: string
    contactId: string
    conversationId: string
    tappedRuleId: string | null
  },
): Promise<boolean> {
  let query = db
    .from('instagram_comments')
    .select('id, rule_id, created_at')
    .eq('account_id', args.accountId)
    .eq('igsid', args.igsid)
    .eq('dm_status', 'awaiting_tap')
    .gte('created_at', new Date(Date.now() - PRIVATE_REPLY_WINDOW_MS).toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
  if (args.tappedRuleId) query = query.eq('rule_id', args.tappedRuleId)
  const { data: pendingRows, error } = await query
  if (error) {
    if (!isMissingTable(error)) console.error('[instagram] pending rule lookup failed:', error)
    return false
  }
  const pending = pendingRows?.[0] as { id: string; rule_id: string | null } | undefined
  const ruleId = args.tappedRuleId ?? pending?.rule_id ?? null
  if (!ruleId) return false

  const { data: ruleRow } = await db
    .from('instagram_keyword_rules')
    .select(RULE_COLUMNS)
    .eq('id', ruleId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  const rule = ruleRow as KeywordRule | null
  if (!rule) return false

  // Claim it before sending, so a double tap delivers once.
  if (pending) {
    const { data: claimed } = await db
      .from('instagram_comments')
      .update({ dm_status: 'delivered', updated_at: new Date().toISOString() })
      .eq('id', pending.id)
      .eq('dm_status', 'awaiting_tap')
      .select('id')
    if (!claimed?.length) return true
  }

  const base = { accountId: args.accountId, conversationId: args.conversationId, contactId: args.contactId }
  if (rule.catalog_item_id) {
    const { data: item } = await db
      .from('ai_attachments')
      .select('name, kind, media_url')
      .eq('id', rule.catalog_item_id)
      .eq('account_id', args.accountId)
      .maybeSingle()
    if (item?.media_url) {
      await instagramEngineSendMedia({
        ...base,
        kind: item.kind === 'document' ? 'document' : 'image',
        link: item.media_url as string,
        caption: (item.name as string) || undefined,
      }).catch((err) => console.error('[instagram] sending the rule catalog item failed:', err))
    }
  }
  const text = ruleContentText(rule)
  if (text) {
    await instagramEngineSendText({ ...base, text }).catch((err) =>
      console.error('[instagram] sending the rule content failed:', err),
    )
  }
  return true
}
