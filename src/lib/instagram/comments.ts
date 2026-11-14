import type { SupabaseClient } from '@supabase/supabase-js'
import { accountModuleEnabled } from '@/lib/modules-server'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'
import { runAutomationById } from '@/lib/automations/engine'
import { notifyOwner } from '@/lib/telegram/send'
import { withoutSupportVisitors } from '@/lib/support/sessions'
import {
  fetchInstagramMedia,
  fetchInstagramUser,
  hideInstagramComment,
  listInstagramMedia,
  replyToInstagramComment,
  sendInstagramPrivateReply,
  type InstagramMedia,
} from './api'
import { loadInstagramConnection } from './connection'
import { classifyComment, type CommentVerdict } from './comment-ai'
import { loadPostOffer } from './offers'
import { DEFAULT_FOLLOW_GATE_TEXT, loadInstagramSettings, type InstagramSettings } from './settings'
import type { InstagramConnection } from './connection'
import { isMissingTable } from './connection'
import { findOrCreateContact, findOrCreateConversation, saveSource } from './contacts'
import { toInstagramText } from './format'
import {
  normalizeRule,
  pickPublicReply,
  pickRule,
  ruleButtonPayload,
  ruleContentText,
  type KeywordRule,
} from './keywords'
import { instagramEngineSendChoices, instagramEngineSendMedia, instagramEngineSendText, rememberSentMid } from './send'
import type { InstagramComment } from './webhook'

// ============================================================
// Instagram comments (phase 2, migration 079, feature module
// `instagram_comments`). A comment that fires a keyword rule gets the
// rule's public reply and its one private DM; every comment is logged in
// `instagram_comments` with what happened. The DM opens a conversation
// in the inbox, so the customer's answer reaches the AI agent like any
// Instagram DM.
//
// Phase 3 (module `instagram_ai_comments`, migration 082): a comment no
// rule caught goes to the AI (comment-ai.ts), which classifies it and
// answers per the owner's actions for that category.
// Phase 5: every private reply counts against the hourly DM limit
// (`dm_sent_at`); over it the DM waits as `queued` and the scheduler
// (`drainInstagramDmQueue`) sends it when there is room again.
// ============================================================

/** Opening text when a rule has a button but no opening of its own. */
export const DEFAULT_DM_OPENING = '¡Hola! 👋 Gracias por tu comentario. Toca el botón y te envío la información por aquí.'
/** Meta allows a private reply up to 7 days after the comment. */
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Button of a "follow first" rule that has no label of its own. */
export const DEFAULT_FOLLOW_BUTTON = 'Ya te sigo ✅'
const HOUR_MS = 60 * 60 * 1000
/** Columns migration 082 adds to the comment log. */
const LOG_082_COLUMNS = ['ai_category', 'ai_private_reply', 'dm_sent_at', 'source']

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
  // `*` so the rules keep working before migration 080 adds its columns.
  const { data, error } = await db.from('instagram_keyword_rules').select('*').eq('account_id', accountId)
  if (error) {
    if (!isMissingTable(error)) console.error('[instagram] loading keyword rules failed:', error)
    return []
  }
  return ((data ?? []) as Record<string, unknown>[]).map(normalizeRule)
}

async function updateComment(db: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<void> {
  const write = (p: Record<string, unknown>) =>
    db.from('instagram_comments').update({ ...p, updated_at: new Date().toISOString() }).eq('id', id)
  let { error } = await write(patch)
  // Before migration 082 its columns don't exist: save the rest.
  if (error && (error.code === 'PGRST204' || error.code === '42703')) {
    const older = Object.fromEntries(Object.entries(patch).filter(([k]) => !LOG_082_COLUMNS.includes(k)))
    ;({ error } = await write(older))
  }
  if (error) console.error('[instagram] updating the comment log failed:', error)
}

/**
 * Private replies still allowed this hour (phase 5). Before migration 082
 * there is no `dm_sent_at`, so there is no queue either.
 */
export async function dmBudgetLeft(db: SupabaseClient, accountId: string, hourlyLimit: number, now: number = Date.now()): Promise<number> {
  const { count, error } = await db
    .from('instagram_comments')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte('dm_sent_at', new Date(now - HOUR_MS).toISOString())
  if (error) return Number.POSITIVE_INFINITY
  return remainingDms(hourlyLimit, count ?? 0)
}

/** Pure: how many DMs fit this hour. */
export function remainingDms(hourlyLimit: number, sentLastHour: number): number {
  return Math.max(0, hourlyLimit - sentLastHour)
}

/** Every comment of one webhook entry. */
export async function processInstagramComments(
  db: SupabaseClient,
  conn: InstagramConnection,
  comments: InstagramComment[],
): Promise<void> {
  if (comments.length === 0) return
  if (!(await accountModuleEnabled(db, conn.accountId, 'instagram_comments'))) return
  const settings = await loadInstagramSettings(db, conn.accountId)
  const aiOn = settings.ai_comments.enabled && (await accountModuleEnabled(db, conn.accountId, 'instagram_ai_comments'))
  const offersOn = await accountModuleEnabled(db, conn.accountId, 'instagram_offers')
  for (const comment of comments) {
    try {
      await processComment(db, conn, comment, { settings, aiOn, offersOn })
    } catch (err) {
      console.error('[instagram] comment failed:', comment.commentId, err)
    }
  }
}

interface CommentRunCtx {
  settings: InstagramSettings
  aiOn: boolean
  offersOn: boolean
}

async function processComment(
  db: SupabaseClient,
  conn: InstagramConnection,
  comment: InstagramComment,
  ctx: CommentRunCtx,
): Promise<void> {
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
  const sourcePatch = comment.source === 'live' ? { source: 'live' } : {}
  if (!hit) {
    const aiPatch = ctx.aiOn ? await answerWithAi(db, conn, comment, post, ctx) : null
    await updateComment(db, logId, { ...sourcePatch, ...(aiPatch ?? { status: 'no_match' }) })
    return
  }
  const { rule, keyword } = hit
  const patch: Record<string, unknown> = { ...sourcePatch, rule_id: rule.id, status: 'replied' }

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
  } else if ((await dmBudgetLeft(db, conn.accountId, ctx.settings.dm_hourly_limit)) <= 0) {
    // Over the hourly DM limit: the queue sends it later (phase 5).
    patch.dm_status = 'queued'
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

/** Whether a post lets the AI answer its comments (082; true before it). */
async function postAllowsAi(db: SupabaseClient, accountId: string, mediaId: string | null): Promise<boolean> {
  if (!mediaId) return true
  const { data, error } = await db
    .from('instagram_posts')
    .select('ai_comments_enabled')
    .eq('account_id', accountId)
    .eq('media_id', mediaId)
    .maybeSingle()
  if (error || !data) return true
  return (data as { ai_comments_enabled?: boolean }).ai_comments_enabled !== false
}

/**
 * Phase 3: a comment no rule caught. The AI classifies it and the
 * category's actions run. Returns the comment-log fields, or null when
 * the AI didn't answer (off for the post, paused, unreadable reply).
 */
async function answerWithAi(
  db: SupabaseClient,
  conn: InstagramConnection,
  comment: InstagramComment,
  post: PostRow | null,
  ctx: CommentRunCtx,
): Promise<Record<string, unknown> | null> {
  if (!comment.text.trim()) return null
  if (!(await postAllowsAi(db, conn.accountId, comment.mediaId))) return null
  const offer = ctx.offersOn && comment.mediaId ? await loadPostOffer(db, conn.accountId, comment.mediaId).catch(() => null) : null
  const verdict = await classifyComment(db, {
    accountId: conn.accountId,
    text: comment.text,
    ownerInstructions: ctx.settings.ai_comments.instructions,
    post: post ? { caption: post.caption, offer: offer?.offer ?? null } : null,
  })
  if (!verdict) return null
  const action = ctx.settings.ai_comments.actions[verdict.category]
  const patch: Record<string, unknown> = { status: 'replied', ai_category: verdict.category }
  let didSomething = false

  if (action.hide) {
    try {
      await hideInstagramComment(conn.accessToken, comment.commentId, true)
      patch.dm_status = 'hidden'
      didSomething = true
    } catch (err) {
      patch.dm_error = `Ocultar: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (action.public && verdict.publicReply && !action.hide) {
    try {
      patch.public_reply_id = await replyToInstagramComment(conn.accessToken, comment.commentId, verdict.publicReply)
      patch.public_reply_text = verdict.publicReply
      didSomething = true
    } catch (err) {
      patch.dm_error = `Respuesta pública: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  if (action.dm && verdict.privateReply && !action.hide) {
    patch.ai_private_reply = verdict.privateReply
    if ((await dmBudgetLeft(db, conn.accountId, ctx.settings.dm_hourly_limit)) <= 0) {
      patch.dm_status = 'queued'
    } else {
      Object.assign(
        patch,
        await sendAiDm(db, conn, verdict.privateReply, {
          commentId: comment.commentId,
          igsid: comment.igsid,
          username: comment.username,
          post,
        }),
      )
    }
    didSomething = true
  }
  if (action.notify) {
    await notifyTeamOfComment(db, conn.accountId, comment, verdict, post).catch((err) =>
      console.error('[instagram] comment alert failed:', err),
    )
    didSomething = true
  }
  if (!didSomething) patch.status = 'no_match'
  return patch
}

const CATEGORY_LABEL: Record<string, string> = {
  question: 'Pregunta',
  interest: 'Interés de compra',
  praise: 'Elogio',
  complaint: 'Queja',
  spam: 'Spam',
  other: 'Otro',
}

/** In-app + Telegram alert to the owners/admins (a complaint, by default). */
async function notifyTeamOfComment(
  db: SupabaseClient,
  accountId: string,
  comment: InstagramComment,
  verdict: CommentVerdict,
  post: PostRow | null,
): Promise<void> {
  const who = comment.username ? `@${comment.username}` : 'Alguien'
  const label = CATEGORY_LABEL[verdict.category] ?? verdict.category
  const title = `${label} en Instagram: ${who}`
  const body = `«${comment.text.slice(0, 300)}»${post?.caption ? `\nEn: ${post.caption.slice(0, 80)}` : ''}`
  await notifyOwner(db, accountId, `📸 ${title}\n${body}${post?.permalink ? `\n${post.permalink}` : ''}`)
  const { data: rows, error } = await db
    .from('profiles')
    .select('user_id')
    .eq('account_id', accountId)
    .in('account_role', ['owner', 'admin'])
  if (error || !rows?.length) return
  const admins = await withoutSupportVisitors(db, accountId, rows as { user_id: string }[])
  if (!admins.length) return
  const row = (type: string) => admins.map((a) => ({ account_id: accountId, user_id: a.user_id, type, title, body }))
  const { error: insertErr } = await db.from('notifications').insert(row('instagram_comment'))
  // 23514: migration 082 (which allows this type) hasn't run yet.
  if (insertErr?.code === '23514') await db.from('notifications').insert(row('handoff_requested'))
  else if (insertErr) console.error('[instagram] comment notification insert failed:', insertErr)
}

/** Saves a private reply in the inbox, opening the conversation. */
async function openConversationWithDm(
  db: SupabaseClient,
  conn: InstagramConnection,
  args: {
    igsid: string
    username: string | null
    post: PostRow | null
    keyword: string | null
    mid: string
    text: string
    button: { title: string; payload: string } | null
    aiGenerated: boolean
  },
): Promise<{ contactId: string; conversationId: string | null } | null> {
  const contactOutcome = await findOrCreateContact(db, conn, args.igsid, args.username)
  if (!contactOutcome) return null
  const contactId = contactOutcome.contact.id
  const convResult = await findOrCreateConversation(db, conn, contactId)
  const conversationId = convResult?.conversation.id ?? null
  if (conversationId) {
    await saveSource(db, conversationId, {
      type: 'comment',
      id: args.post?.media_id ?? null,
      url: args.post?.permalink ?? null,
      title: args.post?.caption ? args.post.caption.slice(0, 200) : null,
      ref: args.keyword,
      at: new Date().toISOString(),
    })
    const now = new Date().toISOString()
    await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'bot',
      status: 'sent',
      content_type: args.button ? 'interactive' : 'text',
      content_text: args.text,
      message_id: args.mid || null,
      ai_generated: args.aiGenerated,
      ...(args.button
        ? { interactive_payload: { kind: 'buttons', body: args.text, buttons: [{ id: args.button.payload, title: args.button.title }] } }
        : {}),
    })
    await db
      .from('conversations')
      .update({ last_message_text: args.text, last_message_at: now, updated_at: now })
      .eq('id', conversationId)
  }
  return { contactId, conversationId }
}

/** The AI's private reply to a comment (phase 3). */
async function sendAiDm(
  db: SupabaseClient,
  conn: InstagramConnection,
  text: string,
  ctx: { commentId: string; igsid: string; username: string | null; post: PostRow | null },
): Promise<Record<string, unknown>> {
  const body = toInstagramText(text).slice(0, 1000)
  let result: { mid: string; recipientId: string | null }
  try {
    result = await sendInstagramPrivateReply(conn.accessToken, ctx.commentId, { kind: 'text', text: body })
  } catch (err) {
    return { dm_status: 'failed', dm_error: err instanceof Error ? err.message : String(err) }
  }
  rememberSentMid(result.mid)
  const opened = await openConversationWithDm(db, conn, {
    igsid: result.recipientId || ctx.igsid,
    username: ctx.username,
    post: ctx.post,
    keyword: null,
    mid: result.mid,
    text: body,
    button: null,
    aiGenerated: true,
  })
  return {
    dm_status: 'sent',
    dm_sent_at: new Date().toISOString(),
    ...(opened ? { contact_id: opened.contactId, conversation_id: opened.conversationId } : {}),
  }
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
  rule: Pick<KeywordRule, 'id' | 'dm_opening' | 'dm_button_label' | 'dm_text' | 'dm_link_url' | 'catalog_item_id'> &
    Partial<Pick<KeywordRule, 'require_follow'>>,
): { text: string; button: { title: string; payload: string } | null } | null {
  // "Follow me to get it" can only be checked once they tap: it always has a button.
  const button = rule.dm_button_label?.trim() || (rule.require_follow ? DEFAULT_FOLLOW_BUTTON : '')
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
  const opened = await openConversationWithDm(db, conn, {
    igsid: result.recipientId || ctx.igsid,
    username: ctx.username,
    post: ctx.post,
    keyword: ctx.keyword,
    mid: result.mid,
    text: sentText,
    button: reply.button && status === 'awaiting_tap' ? reply.button : null,
    aiGenerated: false,
  })
  const sentAt = new Date().toISOString()
  if (!opened) return { dm_status: status, dm_sent_at: sentAt }
  const { contactId, conversationId } = opened

  if (rule.tag_id) {
    await addContactTagAndDispatch({
      db,
      accountId: conn.accountId,
      contactId,
      tagId: rule.tag_id,
      context: conversationId ? { conversation_id: conversationId } : {},
    }).catch((err) => console.error('[instagram] tagging the commenter failed:', err))
  }

  return { dm_status: status, dm_sent_at: sentAt, contact_id: contactId, conversation_id: conversationId }
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
    /** For the follow gate (082); without it the content always goes. */
    accessToken?: string
    followGateText?: string
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
    .select('*')
    .eq('id', ruleId)
    .eq('account_id', args.accountId)
    .maybeSingle()
  const rule = ruleRow ? normalizeRule(ruleRow as Record<string, unknown>) : null
  if (!rule) return false

  const base = { accountId: args.accountId, conversationId: args.conversationId, contactId: args.contactId }
  // "Follow me to get it" (082): not a follower yet → ask again, same button.
  if (rule.require_follow && args.accessToken) {
    const gated = await followGate(args.accessToken, args.igsid, rule, base, args.followGateText)
    if (gated) return true
  }

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

  await deliverRuleContent(db, rule, base)
  return true
}

/**
 * When a rule asks to follow first and the customer doesn't: sends the
 * follow text with the same button and returns true (the content waits).
 * Unknown (Meta didn't say) → false, the content goes.
 */
export async function followGate(
  accessToken: string,
  igsid: string,
  rule: KeywordRule,
  base: { accountId: string; conversationId: string; contactId: string },
  gateText?: string,
): Promise<boolean> {
  const profile = await fetchInstagramUser(accessToken, igsid)
  if (profile?.followsBusiness !== false) return false
  const title = rule.dm_button_label?.trim() || DEFAULT_FOLLOW_BUTTON
  const button = { id: ruleButtonPayload(rule.id), title }
  const bodyText = gateText?.trim() || DEFAULT_FOLLOW_GATE_TEXT
  await instagramEngineSendChoices({
    ...base,
    bodyText,
    buttons: [button],
    payload: { kind: 'buttons', body: bodyText, buttons: [button] },
  }).catch((err) => console.error('[instagram] sending the follow request failed:', err))
  return true
}

/**
 * A rule's content in an open conversation: the catalog item, the file,
 * the text and link, then the automation it starts.
 */
export async function deliverRuleContent(
  db: SupabaseClient,
  rule: KeywordRule,
  base: { accountId: string; conversationId: string; contactId: string },
): Promise<void> {
  if (rule.catalog_item_id) {
    const { data: item } = await db
      .from('ai_attachments')
      .select('name, kind, media_url')
      .eq('id', rule.catalog_item_id)
      .eq('account_id', base.accountId)
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
  // The rule's own file (080): a PDF or a picture. Instagram refuses some
  // files; the customer then gets the link to it instead.
  if (rule.dm_media_url) {
    const kind = rule.dm_media_kind ?? 'document'
    await instagramEngineSendMedia({ ...base, kind, link: rule.dm_media_url }).catch(async (err) => {
      console.error('[instagram] sending the rule file failed, sending its link:', err)
      const label = rule.dm_media_name?.trim() || (kind === 'document' ? '📄 Documento' : '🖼️ Imagen')
      await instagramEngineSendText({ ...base, text: `${label}
${rule.dm_media_url}` }).catch((err2) =>
        console.error('[instagram] sending the rule file link failed:', err2),
      )
    })
  }
  const text = ruleContentText(rule)
  if (text) {
    await instagramEngineSendText({ ...base, text }).catch((err) =>
      console.error('[instagram] sending the rule content failed:', err),
    )
  }
  // Then the automation the rule starts (e.g. qualify the lead): the
  // window is open now, so its messages can go.
  if (rule.automation_id) {
    await runAutomationById({
      accountId: base.accountId,
      automationId: rule.automation_id,
      contactId: base.contactId,
      context: { conversation_id: base.conversationId, vars: { instagram_rule: rule.name } },
    })
  }
}

const QUEUE_BATCH = 500

/**
 * Phase 5: sends the private replies that waited for the hourly limit,
 * oldest first, while each account has room. Queued replies older than
 * Meta's 7 days can't go any more and are marked `expired`. Returns how
 * many were sent. Runs every minute from server-schedulers.ts.
 */
export async function drainInstagramDmQueue(db: SupabaseClient, now: number = Date.now()): Promise<number> {
  const { data, error } = await db
    .from('instagram_comments')
    .select('id, account_id, comment_id, media_id, igsid, username, rule_id, ai_private_reply, created_at')
    .eq('dm_status', 'queued')
    .order('created_at', { ascending: true })
    .limit(QUEUE_BATCH)
  if (error) {
    if (!isMissingTable(error) && error.code !== '42703') console.error('[instagram] loading the DM queue failed:', error)
    return 0
  }
  type Queued = {
    id: string
    account_id: string
    comment_id: string
    media_id: string | null
    igsid: string
    username: string | null
    rule_id: string | null
    ai_private_reply: string | null
    created_at: string
  }
  const rows = (data ?? []) as Queued[]
  const byAccount = new Map<string, Queued[]>()
  for (const row of rows) {
    if (now - new Date(row.created_at).getTime() > PRIVATE_REPLY_WINDOW_MS) {
      await updateComment(db, row.id, { dm_status: 'expired', dm_error: 'Pasaron los 7 días que Instagram permite para responder en privado.' })
      continue
    }
    byAccount.set(row.account_id, [...(byAccount.get(row.account_id) ?? []), row])
  }

  let sent = 0
  for (const [accountId, queued] of byAccount) {
    try {
      if (!(await accountModuleEnabled(db, accountId, 'instagram_comments'))) continue
      const conn = await loadInstagramConnection(db, accountId)
      if (!conn) continue
      const settings = await loadInstagramSettings(db, accountId)
      let budget = await dmBudgetLeft(db, accountId, settings.dm_hourly_limit, now)
      if (budget <= 0) continue
      const rules = queued.some((q) => q.rule_id) ? await loadKeywordRules(db, accountId) : []
      for (const row of queued) {
        if (budget <= 0) break
        // Claim the row so two instances never send the same DM.
        const { data: claimed } = await db
          .from('instagram_comments')
          .update({ dm_status: 'sending', updated_at: new Date().toISOString() })
          .eq('id', row.id)
          .eq('dm_status', 'queued')
          .select('id')
        if (!claimed?.length) continue
        const post = row.media_id ? await ensurePost(db, conn, row.media_id).catch(() => null) : null
        const ctx = { commentId: row.comment_id, igsid: row.igsid, username: row.username, post }
        const rule = row.rule_id ? rules.find((r) => r.id === row.rule_id) : null
        let patch: Record<string, unknown>
        if (rule) patch = await sendRuleDm(db, conn, rule, { ...ctx, keyword: null })
        else if (row.ai_private_reply) patch = await sendAiDm(db, conn, row.ai_private_reply, ctx)
        else patch = { dm_status: 'failed', dm_error: 'La regla ya no existe.' }
        if (!patch.dm_status) patch.dm_status = 'failed'
        await updateComment(db, row.id, patch)
        budget -= 1
        if (patch.dm_status !== 'failed') sent += 1
      }
    } catch (err) {
      console.error('[instagram] draining the DM queue failed for', accountId, err)
    }
  }
  return sent
}
