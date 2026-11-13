import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { assignChatWithoutAi } from '@/lib/assignment/server'
import { isAiBookingSlotReply } from '@/lib/ai/providers/shared'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import { accountModuleEnabled } from '@/lib/modules-server'
import { findOrCreateContact, findOrCreateConversation, mirrorUrl, saveSource } from './contacts'
import { findInstagramConnectionByIgUser, type InstagramConnection } from './connection'
import { wasSentByUs } from './send'
import { deliverPendingRuleContent, processInstagramComments } from './comments'
import { ruleIdFromPayload } from './keywords'
import {
  describeInstagramEvent,
  parseInstagramComments,
  parseInstagramEntry,
  referralSource,
  type InstagramEvent,
  type InstagramWebhookBody,
} from './webhook'

// ============================================================
// Inbound Instagram DMs (module `instagram`, migration 078). Mirrors the
// WhatsApp webhook's pipeline: contact + conversation (channel
// 'instagram'), idempotent insert, unread bump, reopen, flows,
// automations, the AI agent and the public webhooks. Replies go out
// through the same engine senders, which route to Instagram by the
// conversation's channel.
// ============================================================

/** How long to wait before deciding an echo was typed in the Instagram app. */
const ECHO_SETTLE_MS = 4000

export async function processInstagramWebhook(body: InstagramWebhookBody): Promise<void> {
  if (body.object && body.object !== 'instagram') return
  const db = supabaseAdmin()
  const echoes: Promise<void>[] = []
  for (const entry of body.entry ?? []) {
    const events = parseInstagramEntry(entry)
    const hasComments = (entry.changes ?? []).some((c) => c.field === 'comments')
    if (events.length === 0 && !hasComments) continue
    const conn = await findInstagramConnectionByIgUser(db, entry.id)
    if (!conn) {
      console.warn('[instagram] webhook for an unconnected account:', entry.id)
      continue
    }
    if (!(await accountModuleEnabled(db, conn.accountId, 'instagram'))) continue
    // Rows need a NOT NULL user_id: whoever connected Instagram, else the
    // account owner (that teammate may have left).
    if (!conn.connectedBy) {
      const { data: account } = await db.from('accounts').select('owner_user_id').eq('id', conn.accountId).maybeSingle()
      conn.connectedBy = (account?.owner_user_id as string | undefined) ?? null
    }
    // Comments on posts and reels: keyword rules (phase 2).
    const comments = hasComments ? parseInstagramComments(entry, conn.username) : []
    if (comments.length > 0) await processInstagramComments(db, conn, comments)
    for (const event of events) {
      try {
        if (event.kind === 'echo') echoes.push(handleEcho(db, conn, event))
        else if (event.kind === 'read') await handleRead(db, event.mid)
        else if (event.kind === 'referral') await handleReferral(db, conn, event)
        else await handleCustomerEvent(db, conn, event)
      } catch (err) {
        console.error('[instagram] event failed:', event.kind, err)
      }
    }
  }
  await Promise.all(echoes)
}

async function handleCustomerEvent(
  db: SupabaseClient,
  conn: InstagramConnection,
  event: Extract<InstagramEvent, { kind: 'message' | 'postback' }>,
): Promise<void> {
  const { parts, source } = describeInstagramEvent(event)
  if (parts.length === 0) return

  const contactOutcome = await findOrCreateContact(db, conn, event.igsid)
  if (!contactOutcome) return
  const contact = contactOutcome.contact
  const convResult = await findOrCreateConversation(db, conn, contact.id)
  if (!convResult) return
  const conversation = convResult.conversation

  if (convResult.created) {
    await dispatchWebhookEvent(db, conn.accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contact.id,
    })
  }

  let replyToInternalId: string | null = null
  if (event.kind === 'message' && event.replyToMid) {
    const { data } = await db
      .from('messages')
      .select('id')
      .eq('conversation_id', conversation.id)
      .eq('message_id', event.replyToMid)
      .maybeSingle()
    replyToInternalId = (data?.id as string | undefined) ?? null
  }

  const { count: priorCount } = await db
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCount ?? 0) === 0

  // Idempotent insert, like WhatsApp: a redelivery conflicts on
  // (conversation_id, message_id) and inserts nothing.
  const createdAt = new Date(event.timestamp).toISOString()
  const rows = []
  for (const part of parts) {
    const mediaUrl = part.mediaUrl ? await mirrorUrl(conn.accountId, part.mid, part.mediaUrl, event.timestamp) : null
    rows.push({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: part.contentType,
      content_text: part.contentText,
      media_url: mediaUrl,
      message_id: part.mid,
      status: 'delivered',
      created_at: createdAt,
      reply_to_message_id: replyToInternalId,
      interactive_reply_id: part.interactiveReplyId,
    })
  }
  const { data: inserted, error: insertErr } = await db
    .from('messages')
    .upsert(rows, { onConflict: 'conversation_id,message_id', ignoreDuplicates: true })
    .select('id')
  if (insertErr) {
    console.error('[instagram] inserting the message failed:', insertErr)
    return
  }
  if (!inserted || inserted.length === 0) return // redelivery

  const first = parts[0]
  const preview = first.contentText || `[${first.contentType}]`
  const { error: bumpErr } = await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conversation.id,
    p_last_message_text: preview,
  })
  if (bumpErr) console.error('[instagram] updating the conversation failed:', bumpErr)
  await reopenClosedConversation(db, conversation)
  await saveSource(db, conversation.id, source)

  const inboundText = parts.map((p) => p.contentText).filter(Boolean).join('\n')
  const interactiveReplyId = first.interactiveReplyId
  const userId = conn.connectedBy ?? ''

  // The answer to a keyword rule's opening DM (its button, or anything
  // typed back): the window is open now, so the rule's content goes out
  // and stands in for the agent's reply to this message.
  const tappedRuleId = ruleIdFromPayload(interactiveReplyId)
  const deliveredRule = await deliverPendingRuleContent(db, {
    accountId: conn.accountId,
    igsid: event.igsid,
    contactId: contact.id,
    conversationId: conversation.id,
    tappedRuleId,
  }).catch((err) => {
    console.error('[instagram] delivering the rule content failed:', err)
    return false
  })
  if (tappedRuleId || deliveredRule) {
    await dispatchWebhookEvent(db, conn.accountId, 'message.received', {
      conversation_id: conversation.id,
      contact_id: contact.id,
      whatsapp_message_id: first.mid,
      content_type: first.contentType,
      text: inboundText || null,
      channel: 'instagram',
    })
    return
  }

  const flowResult = await dispatchInboundToFlows({
    accountId: conn.accountId,
    userId,
    contactId: contact.id,
    conversationId: conversation.id,
    message: interactiveReplyId
      ? { kind: 'interactive_reply', reply_id: interactiveReplyId, reply_title: first.contentText ?? '', meta_message_id: first.mid }
      : { kind: 'text', text: inboundText, meta_message_id: first.mid },
    isFirstInboundMessage,
  })

  const triggers: ('new_contact_created' | 'first_inbound_message' | 'new_message_received' | 'keyword_match' | 'interactive_reply')[] = []
  if (!flowResult.consumed) {
    triggers.push('new_message_received', 'keyword_match')
    if (interactiveReplyId) triggers.push('interactive_reply')
  }
  if (contactOutcome.created) triggers.unshift('new_contact_created')
  if (isFirstInboundMessage) triggers.unshift('first_inbound_message')
  for (const triggerType of triggers) {
    await runAutomationsForTrigger({
      accountId: conn.accountId,
      triggerType,
      contactId: contact.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
        interactive_reply_id: interactiveReplyId ?? undefined,
      },
    }).catch((err) => console.error('[instagram] automations dispatch failed:', err))
  }

  const understandable = parts.some((p) => ['image', 'audio', 'document'].includes(p.contentType))
  if (
    !flowResult.consumed &&
    (!interactiveReplyId || isAiBookingSlotReply(interactiveReplyId)) &&
    (inboundText.trim() || understandable)
  ) {
    if (conn.aiEnabled) {
      await dispatchInboundToAiReply({
        accountId: conn.accountId,
        conversationId: conversation.id,
        contactId: contact.id,
        configOwnerUserId: userId,
      })
    } else {
      // The AI is off for Instagram: like WhatsApp with the AI off, a
      // teammate gets the chat when `assign_when_ai_off` is set.
      await assignChatWithoutAi(db, { accountId: conn.accountId, conversationId: conversation.id, contactId: contact.id })
    }
  }

  await dispatchWebhookEvent(db, conn.accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contact.id,
    whatsapp_message_id: first.mid,
    content_type: first.contentType,
    text: inboundText || null,
    channel: 'instagram',
  })
}

/** Our sent messages turn "read" when the customer opens them. */
async function handleRead(db: SupabaseClient, mid: string): Promise<void> {
  await db.from('messages').update({ status: 'read' }).eq('message_id', mid).neq('sender_type', 'customer')
}

/** An ad click or ig.me link opening the chat, before any message. */
async function handleReferral(
  db: SupabaseClient,
  conn: InstagramConnection,
  event: Extract<InstagramEvent, { kind: 'referral' }>,
): Promise<void> {
  const contactOutcome = await findOrCreateContact(db, conn, event.igsid)
  if (!contactOutcome) return
  const convResult = await findOrCreateConversation(db, conn, contactOutcome.contact.id)
  if (!convResult) return
  await saveSource(db, convResult.conversation.id, referralSource(event.referral, new Date(event.timestamp).toISOString()))
}

/**
 * Meta echoes every message the account sends. Ours (AI, flows, the
 * inbox) are already saved; anything else was typed by a person in the
 * Instagram app, so it's saved as the team's and the AI steps back on
 * that chat (the inbox banner turns it back on).
 */
async function handleEcho(
  db: SupabaseClient,
  conn: InstagramConnection,
  event: Extract<InstagramEvent, { kind: 'echo' }>,
): Promise<void> {
  if (wasSentByUs(event.mid)) return
  await new Promise((r) => setTimeout(r, ECHO_SETTLE_MS))
  if (wasSentByUs(event.mid)) return
  const { data: known } = await db.from('messages').select('id').eq('message_id', event.mid).limit(1)
  if (known && known.length > 0) return

  const { data: contact } = await db
    .from('contacts')
    .select('id')
    .eq('account_id', conn.accountId)
    .eq('instagram_id', event.igsid)
    .maybeSingle()
  if (!contact) return
  const convResult = await findOrCreateConversation(db, conn, contact.id as string)
  if (!convResult) return
  const conversationId = convResult.conversation.id

  const media = event.attachments.find((a) => a.url && ['image', 'video', 'audio', 'file'].includes(a.type))
  const contentType = media ? (media.type === 'file' ? 'document' : media.type) : 'text'
  const mediaUrl = media?.url ? await mirrorUrl(conn.accountId, event.mid, media.url, event.timestamp) : null
  if (!event.text && !mediaUrl) return
  const { error } = await db.from('messages').upsert(
    {
      conversation_id: conversationId,
      sender_type: 'agent',
      content_type: contentType,
      content_text: event.text,
      media_url: mediaUrl,
      message_id: event.mid,
      status: 'sent',
      created_at: new Date(event.timestamp).toISOString(),
    },
    { onConflict: 'conversation_id,message_id', ignoreDuplicates: true },
  )
  if (error) {
    console.error('[instagram] saving an app-typed reply failed:', error)
    return
  }
  const now = new Date().toISOString()
  await db
    .from('conversations')
    .update({
      last_message_text: event.text || `[${contentType}]`,
      last_message_at: now,
      updated_at: now,
      ai_autoreply_disabled: true,
    })
    .eq('id', conversationId)
}
