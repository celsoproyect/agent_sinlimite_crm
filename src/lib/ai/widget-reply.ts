import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge, retrieveKnowledgeFromKb, getKnowledgeBaseRoster } from './knowledge'
import { applyLeadCapture, getCustomFieldRoster, getLeadPipelineStages } from './custom-fields'
import {
  bookingEnabled,
  cancelAiBooking,
  checkAvailability,
  confirmAiBooking,
  findCustomerBookings,
  getBusinessHoursSummary,
  rescheduleAiBooking,
} from './booking'
import { generateReply } from './generate'
import { formatClinicRoster, clinicSearchTool, getClinicDirectory } from '@/lib/clinic/directory'
import { buildSystemPrompt } from './defaults'
import { agendaModuleOn, loadVenue, venuePromptOptions, venueTools } from './venue'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { notifyOwnerOfHandoff } from '@/lib/telegram/send'
import { accountModuleEnabled } from '@/lib/modules-server'

interface WidgetReplyArgs {
  db: SupabaseClient
  accountId: string
  conversationId: string
  /** The widget visitor's contact row — used to decide whether to ask for
   *  their name and, if so, where to persist it once captured. */
  contactId: string
  contactName: string
  /** Account owner — `deals.user_id` for a lead the AI opens. */
  ownerUserId: string
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
 * Text only: no attachments (media messages need a widget-side
 * renderer). Booking works when the account saved its hours: the same
 * tools as WhatsApp, but the model lists the offered slots in its text
 * because the widget has no buttons, and it always asks for the phone
 * since a web visitor has none on file.
 */
export async function generateWidgetReply(args: WidgetReplyArgs): Promise<WidgetReplyOutcome> {
  const { db, accountId, conversationId, contactId, contactName, ownerUserId } = args
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
  // Null cap = "sin límite" (migration 057) — `>= null` coerces to `>= 0`
  // in JS and would wrongly read as "cap reached" on the very first
  // reply, so this must be guarded explicitly rather than compared bare.
  if (
    config.autoReplyMaxPerConversation != null &&
    conv.ai_reply_count >= config.autoReplyMaxPerConversation
  )
    return { ok: false, reason: 'reply_cap_reached' }

  const messages = await buildConversationContext(db, conversationId, {
    accountId,
    embeddingsApiKey: config.embeddingsApiKey,
  })
  if (messages.length === 0) return { ok: false, reason: 'ai_unavailable' }

  const acctLimit = checkRateLimit(`ai-autoreply:${accountId}`, RATE_LIMITS.aiAutoReplyAccount)
  if (!acctLimit.success) return { ok: false, reason: 'rate_limited' }

  const widgetBooking = await accountModuleEnabled(db, accountId, 'widget_booking')
  const [knowledge, knowledgeBases, bookingAvailable, businessHoursSummary, customFieldRoster, leadStageRoster, clinic, venue] = await Promise.all([
    retrieveKnowledge(db, accountId, config, latestUserMessage(messages)),
    getKnowledgeBaseRoster(db, accountId),
    // Saved hours, the agenda module AND the widget_booking module on.
    widgetBooking
      ? Promise.all([bookingEnabled(db, accountId), agendaModuleOn(db, accountId)]).then(([hours, agenda]) => hours && agenda)
      : Promise.resolve(false),
    getBusinessHoursSummary(db, accountId),
    getCustomFieldRoster(db, accountId),
    config.leadPipelineId ? getLeadPipelineStages(db, config.leadPipelineId) : Promise.resolve([]),
    getClinicDirectory(db, accountId),
    // Tables and halls are booked from the widget under the same switch.
    widgetBooking ? loadVenue(db, accountId) : Promise.resolve({ restaurant: null, events: null }),
  ])
  const venueOn = !!(venue.restaurant || venue.events)
  const customFieldNames = customFieldRoster.map((f) => f.field_name)
  const leadStageNames = leadStageRoster.map((s) => s.name)

  const systemPrompt = buildSystemPrompt({
    userPrompt: config.systemPrompt,
    mode: 'auto_reply',
    knowledge,
    knowledgeBases,
    toolAvailable: true,
    attachmentsAvailable: false,
    bookingAvailable,
    businessHoursSummary,
    bookingManageAvailable: bookingAvailable || venueOn,
    bookingSlotButtons: false,
    clinicRoster: clinic ? formatClinicRoster(clinic) : null,
    ...venuePromptOptions(venue),
    needsCustomerName,
    handoffOnMissingInfo: config.handoffOnMissingInfo,
    noteCaptureAvailable: true,
    customFieldNames,
    leadStageNames,
    sentimentCaptureAvailable: true,
  })

  const { text, handoff, usage, customerName, note, customFields, leadStage, leadValue, sentiment } = await generateReply({
    config,
    systemPrompt,
    messages,
    knowledgeBases,
    searchKnowledgeBase: ({ query, knowledgeBaseName }) =>
      knowledgeBaseName
        ? retrieveKnowledgeFromKb(db, accountId, config, query, knowledgeBaseName)
        : Promise.resolve([]),
    checkAvailability: bookingAvailable
      ? ({ date, time, professionalId, specialty, serviceId }) =>
          checkAvailability(db, accountId, date, time, 3, { directory: clinic, professionalId, specialty, serviceId })
      : undefined,
    clinicTool: bookingAvailable && clinic ? clinicSearchTool(clinic) : undefined,
    bookAppointment: bookingAvailable
      ? (appointment) => confirmAiBooking(db, { accountId, contactId, conversationId, appointment, directory: clinic })
      : undefined,
    venueTools: venueTools(db, venue, { accountId, contactId, conversationId, write: true }),
    manageAppointments:
      bookingAvailable || venueOn
      ? {
          find: ({ phone }) => findCustomerBookings(db, { accountId, contactId, phone, directory: clinic }),
          reschedule: (a) =>
            rescheduleAiBooking(db, { accountId, contactId, conversationId, ...a, directory: clinic, restaurant: venue.restaurant }),
          cancel: (a) => cancelAiBooking(db, { accountId, contactId, conversationId, ...a, directory: clinic }),
        }
      : undefined,
    captureCustomerName: needsCustomerName,
    captureNote: true,
    customFieldNames: customFieldNames.length > 0 ? customFieldNames : undefined,
    leadStageNames: leadStageNames.length > 0 ? leadStageNames : undefined,
    captureSentiment: true,
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

  if (note) {
    try {
      await db.from('contact_notes').insert({
        contact_id: contactId,
        account_id: accountId,
        user_id: null,
        note_text: note,
        source: 'ai',
      })
    } catch (err) {
      console.error('[widget ai reply] note insert failed:', err)
    }
  }

  if (customFields && customFields.length > 0) {
    for (const captured of customFields) {
      const fieldId = customFieldRoster.find((f) => f.field_name === captured.field)?.id
      if (!fieldId) continue
      try {
        await db
          .from('contact_custom_values')
          .upsert(
            { contact_id: contactId, custom_field_id: fieldId, value: captured.value },
            { onConflict: 'contact_id,custom_field_id' },
          )
      } catch (err) {
        console.error('[widget ai reply] custom field upsert failed:', err)
      }
    }
  }

  if (leadStage && config.leadPipelineId) {
    await applyLeadCapture(db, {
      accountId,
      contactId,
      conversationId,
      ownerUserId,
      pipelineId: config.leadPipelineId,
      stageRoster: leadStageRoster,
      stage: leadStage,
      value: leadValue,
      title: customerName || (needsCustomerName ? 'Visitante web' : contactName),
      renameTitle: !!customerName,
    })
  }

  if (sentiment) {
    try {
      await db
        .from('contacts')
        .update({ ai_sentiment: sentiment, ai_sentiment_updated_at: new Date().toISOString() })
        .eq('id', contactId)
    } catch (err) {
      console.error('[widget ai reply] sentiment update failed:', err)
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
    try {
      await db.from('contact_notes').insert({
        contact_id: contactId,
        account_id: accountId,
        user_id: null,
        note_text: summary,
        source: 'ai',
      })
    } catch (err) {
      console.error('[widget ai reply] handoff note insert failed:', err)
    }
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
    ai_generated: true,
  })
  if (insertErr) {
    // Mirror the WhatsApp path: a failed persist means the visitor never
    // got a reply, so give the claimed slot back rather than burning it.
    console.error('[widget ai reply] message insert failed, releasing claimed reply slot:', insertErr)
    try {
      await db.rpc('release_ai_reply_slot', { conversation_id: conversationId })
    } catch (releaseErr) {
      console.error('[widget ai reply] release_ai_reply_slot failed:', releaseErr)
    }
    throw insertErr
  }

  await db
    .from('conversations')
    .update({ last_message_text: text, last_message_at: new Date().toISOString() })
    .eq('id', conversationId)

  return { ok: true, text }
}
