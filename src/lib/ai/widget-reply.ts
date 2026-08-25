import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge, retrieveKnowledgeFromKb, getKnowledgeBaseRoster } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { notifyOwnerOfHandoff } from '@/lib/telegram/send'

interface WidgetReplyArgs {
  db: SupabaseClient
  accountId: string
  conversationId: string
  /** The widget visitor's contact row — used to decide whether to ask for
   *  their name and, if so, where to persist it once captured. */
  contactId: string
  contactName: string
}

export type WidgetReplyOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: 'ai_unavailable' | 'human_owns_thread' | 'reply_cap_reached' | 'rate_limited' | 'handoff' }

/**
 * AI reply for one inbound web-widget message, generated and returned
 * synchronously in the same HTTP request the visitor's message arrived
 * on — there's no webhook `after()` tail here, so unlike
 * `dispatchInboundToAiReply` this throws on a real provider/DB failure
 * instead of swallowing it; the route decides what the visitor sees.
 *
 * v1 scope: text-only. No attachments, no booking tools — both are
 * WhatsApp-shaped UX (interactive buttons, media messages) that would
 * either silently do nothing or need a parallel widget-side renderer.
 * Kept out entirely rather than half-wired.
 */
export async function generateWidgetReply(args: WidgetReplyArgs): Promise<WidgetReplyOutcome> {
  const { db, accountId, conversationId, contactId, contactName } = args
  // "Visitante web" is the placeholder findOrCreateWidgetContact falls
  // back to when the visitor never supplied a name — the signal nobody's
  // captured a real one yet.
  const needsCustomerName = !contactName || contactName === 'Visitante web'

  const config = await loadAiConfig(db, accountId)
  if (!config || !config.autoReplyEnabled) return { ok: false, reason: 'ai_unavailable' }

  // Same stand-down as the WhatsApp path: a message-level automation
  // (if one is ever wired to fire on web-channel inbound) shouldn't be
  // double-texted by the bot too.
  const { data: autoResponders } = await db
    .from('automations')
    .select('id')
    .eq('account_id', accountId)
    .eq('is_active', true)
    .in('trigger_type', ['new_message_received', 'keyword_match'])
    .limit(1)
  if (autoResponders && autoResponders.length > 0) return { ok: false, reason: 'ai_unavailable' }

  const { data: conv, error: convErr } = await db
    .from('conversations')
    .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count')
    .eq('id', conversationId)
    .maybeSingle()
  if (convErr || !conv) return { ok: false, reason: 'ai_unavailable' }
  if (conv.assigned_agent_id) return { ok: false, reason: 'human_owns_thread' }
  if (conv.ai_autoreply_disabled) return { ok: false, reason: 'human_owns_thread' }
  if (conv.ai_reply_count >= config.autoReplyMaxPerConversation) return { ok: false, reason: 'reply_cap_reached' }

  const messages = await buildConversationContext(db, conversationId, {
    accountId,
    embeddingsApiKey: config.embeddingsApiKey,
  })
  if (messages.length === 0) return { ok: false, reason: 'ai_unavailable' }

  const acctLimit = checkRateLimit(`ai-autoreply:${accountId}`, RATE_LIMITS.aiAutoReplyAccount)
  if (!acctLimit.success) return { ok: false, reason: 'rate_limited' }

  const [knowledge, knowledgeBases] = await Promise.all([
    retrieveKnowledge(db, accountId, config, latestUserMessage(messages)),
    getKnowledgeBaseRoster(db, accountId),
  ])

  const systemPrompt = buildSystemPrompt({
    userPrompt: config.systemPrompt,
    mode: 'auto_reply',
    knowledge,
    knowledgeBases,
    toolAvailable: true,
    attachmentsAvailable: false,
    bookingAvailable: false,
    needsCustomerName,
  })

  const { text, handoff, usage, customerName } = await generateReply({
    config,
    systemPrompt,
    messages,
    knowledgeBases,
    searchKnowledgeBase: ({ query, knowledgeBaseName }) =>
      knowledgeBaseName
        ? retrieveKnowledgeFromKb(db, accountId, config, query, knowledgeBaseName)
        : Promise.resolve([]),
    captureCustomerName: needsCustomerName,
  })

  if (customerName) {
    try {
      await db
        .from('contacts')
        .update({ name: customerName, updated_at: new Date().toISOString() })
        .eq('id', contactId)
    } catch (err) {
      console.error('[widget ai reply] contact name update failed:', err)
    }
  }

  void logAiUsage(db, {
    accountId,
    conversationId,
    mode: 'auto_reply',
    provider: config.provider,
    model: config.model,
    usage,
  })

  if (handoff || !text) {
    const summary = buildHandoffSummary({ messages, replyCount: conv.ai_reply_count ?? 0 })
    const update: Record<string, unknown> = {
      ai_autoreply_disabled: true,
      ai_handoff_summary: summary,
    }
    if (config.handoffAgentId) update.assigned_agent_id = config.handoffAgentId
    await db.from('conversations').update(update).eq('id', conversationId)
    void notifyOwnerOfHandoff(db, accountId, {
      contactName: needsCustomerName ? 'Un visitante web' : contactName,
      summary,
      conversationId,
    })
    return { ok: false, reason: 'handoff' }
  }

  const { data: claimed, error: claimErr } = await db.rpc('claim_ai_reply_slot', {
    conversation_id: conversationId,
    max_replies: config.autoReplyMaxPerConversation,
  })
  if (claimErr) {
    console.error('[widget ai reply] claim_ai_reply_slot failed:', claimErr)
    return { ok: false, reason: 'ai_unavailable' }
  }
  if (claimed !== true) return { ok: false, reason: 'reply_cap_reached' }

  const { error: insertErr } = await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'bot',
    content_type: 'text',
    content_text: text,
    status: 'sent',
  })
  if (insertErr) throw insertErr

  await db
    .from('conversations')
    .update({ last_message_text: text, last_message_at: new Date().toISOString() })
    .eq('id', conversationId)

  return { ok: true, text }
}
