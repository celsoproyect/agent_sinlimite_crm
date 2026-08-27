import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge, retrieveKnowledgeFromKb, getKnowledgeBaseRoster } from './knowledge'
import { getAttachmentRoster, searchAttachments } from './attachments'
import { bookingEnabled, checkAvailability, insertAiBooking } from './booking'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import { buildHandoffSummary } from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { formatLocalHHMM } from './providers/shared'
import { engineSendText, engineSendMedia, engineSendInteractiveButtons } from '@/lib/flows/meta-send'
import type { InteractiveButton } from '@/lib/whatsapp/meta-api'
import type { ProductCardMetadata } from '@/types'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { notifyOwnerOfHandoff } from '@/lib/telegram/send'

// Pending reply-delay timers, keyed by conversation. In-process only —
// doesn't survive a restart and doesn't coordinate across replicas, which
// is fine for the single-instance Dokploy deployment this targets but is
// worth knowing if that ever changes. A conversation only ever has one
// entry: while it's set, further inbounds during the wait are folded into
// the pending fire instead of scheduling their own timer (see the
// `pendingReplyTimers.has` check above).
const pendingReplyTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleDelayedReply(conversationId: string, waitMs: number, args: DispatchArgs): void {
  const timer = setTimeout(() => {
    pendingReplyTimers.delete(conversationId)
    void dispatchInboundToAiReply(args)
  }, waitMs)
  pendingReplyTimers.set(conversationId, timer)
}

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - the per-conversation reply cap is reached
 *   - there's nothing to reply to
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args
  console.log('[ai auto-reply][debug] entry', { accountId, conversationId })

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) {
      console.log('[ai auto-reply][debug] exit: no config or auto-reply disabled', {
        hasConfig: !!config,
        autoReplyEnabled: config?.autoReplyEnabled,
      })
      return
    }

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) {
      console.log('[ai auto-reply][debug] exit: active automation auto-responder stands down')
      return
    }

    const { data: conv, error: convErr } = await db
      .from('conversations')
      .select('assigned_agent_id, ai_autoreply_disabled, ai_reply_count, last_ai_reply_at')
      .eq('id', conversationId)
      .maybeSingle()
    if (convErr || !conv) {
      console.log('[ai auto-reply][debug] exit: conversation fetch failed or missing', convErr)
      return
    }
    if (conv.assigned_agent_id) {
      console.log('[ai auto-reply][debug] exit: human agent assigned', conv.assigned_agent_id)
      return // a human owns this thread
    }
    if (conv.ai_autoreply_disabled) {
      console.log('[ai auto-reply][debug] exit: ai_autoreply_disabled on conversation')
      return // handed off / turned off here
    }
    // Cheap early-out; the authoritative cap check is the atomic claim
    // below (this read can race a concurrent inbound). Null cap = "sin
    // límite" (migration 057) — never early-out on it.
    if (
      config.autoReplyMaxPerConversation != null &&
      conv.ai_reply_count >= config.autoReplyMaxPerConversation
    ) {
      console.log('[ai auto-reply][debug] exit: per-conversation cap reached', {
        replyCount: conv.ai_reply_count,
        cap: config.autoReplyMaxPerConversation,
      })
      return
    }

    // Reply delay (WhatsApp-only, migration 057): the bot waits
    // `replyDelaySeconds` after ITS OWN last reply before answering
    // again, so a burst of customer messages sent in that window gets
    // answered together on one call instead of one bot reply per
    // inbound. Anchored to `last_ai_reply_at` (not to this inbound), so
    // a message arriving mid-wait never pushes the wait out further —
    // it just rides the timer that's already running.
    if (config.replyDelaySeconds > 0) {
      if (pendingReplyTimers.has(conversationId)) {
        console.log('[ai auto-reply][debug] exit: already queued for the pending delayed fire')
        return // already queued for the pending fire
      }
      if (conv.last_ai_reply_at) {
        const waitMs =
          config.replyDelaySeconds * 1000 - (Date.now() - new Date(conv.last_ai_reply_at).getTime())
        if (waitMs > 0) {
          console.log('[ai auto-reply][debug] scheduling delayed reply', {
            waitMs,
            lastAiReplyAt: conv.last_ai_reply_at,
          })
          scheduleDelayedReply(conversationId, waitMs, args)
          return
        }
      }
    }

    const messages = await buildConversationContext(db, conversationId, {
      accountId,
      embeddingsApiKey: config.embeddingsApiKey,
    })
    if (messages.length === 0) {
      console.log('[ai auto-reply][debug] exit: empty conversation context')
      return
    }
    console.log('[ai auto-reply][debug] proceeding to generate reply', { messageCount: messages.length })

    // A name is "on file" once it's a real, non-placeholder value — on
    // WhatsApp the contact is created with `name || phone` (see the
    // webhook's findOrCreateContact), so the phone-as-name fallback is the
    // signal that Meta never sent a profile name and nobody's captured one
    // since. Best-effort: any read failure just skips the ask.
    const { data: contactRow } = await db
      .from('contacts')
      .select('name, phone')
      .eq('id', contactId)
      .maybeSingle()
    const needsCustomerName = !!contactRow && (!contactRow.name || contactRow.name === contactRow.phone)

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const [knowledge, knowledgeBases, attachmentRoster, bookingAvailable] = await Promise.all([
      retrieveKnowledge(db, accountId, config, latestUserMessage(messages)),
      getKnowledgeBaseRoster(db, accountId),
      getAttachmentRoster(db, accountId),
      bookingEnabled(db, accountId),
    ])
    const attachmentsEnabled = attachmentRoster.length > 0

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      knowledgeBases,
      toolAvailable: true,
      attachmentsAvailable: attachmentsEnabled,
      attachmentNames: attachmentRoster.map((a) => a.name),
      bookingAvailable,
      needsCustomerName,
    })

    const { text, handoff, usage, attachments, booking, customerName } = await generateReply({
      config,
      systemPrompt,
      messages,
      knowledgeBases,
      searchKnowledgeBase: ({ query, knowledgeBaseName }) =>
        knowledgeBaseName
          ? retrieveKnowledgeFromKb(db, accountId, config, query, knowledgeBaseName)
          : Promise.resolve([]),
      searchAttachments: attachmentsEnabled
        ? ({ query }) => searchAttachments(db, accountId, query)
        : undefined,
      checkAvailability: bookingAvailable
        ? ({ date }) => checkAvailability(db, accountId, date)
        : undefined,
      captureCustomerName: needsCustomerName,
    })

    // Persist a captured name right away, regardless of handoff — the
    // conversation should show the real name in the inbox even if the
    // model then bails to a human. Best-effort: never blocks the reply.
    if (customerName) {
      try {
        await db
          .from('contacts')
          .update({ name: customerName, updated_at: new Date().toISOString() })
          .eq('id', contactId)
      } catch (err) {
        console.error('[ai auto-reply] contact name update failed:', err)
      }
    }

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    if (handoff || !text) {
      // The model can't (or shouldn't) answer — stop auto-replying on
      // this thread and hand it to a human. We (a) pause the bot here
      // (sticky until re-enabled), (b) route the conversation to the
      // configured handoff agent — null leaves it in the shared queue —
      // and (c) leave a short internal note so whoever picks it up has
      // context. Assigning fires the `on_conversation_assigned` trigger,
      // which notifies the agent.
      const summary = buildHandoffSummary({
        messages,
        replyCount: conv.ai_reply_count ?? 0,
      })
      const update: Record<string, unknown> = {
        ai_autoreply_disabled: true,
        ai_handoff_summary: summary,
      }
      // Only set the assignee when a target is configured AND the thread
      // isn't already owned — never stomp an existing human assignment.
      if (config.handoffAgentId && !conv.assigned_agent_id) {
        update.assigned_agent_id = config.handoffAgentId
      }
      await db.from('conversations').update(update).eq('id', conversationId)
      void notifyOwnerOfHandoff(db, accountId, {
        contactName: contactRow?.name || contactRow?.phone || 'Un cliente',
        summary,
        conversationId,
      })
      return
    }

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    // When the model offered real slots via check_availability, fold the
    // reply text into the interactive message body so the offer and the
    // tappable buttons land as one WhatsApp message, in the customer's own
    // language (the AI already wrote `text` in that language). Fall back
    // to a plain text send if the interactive send fails for any reason
    // (e.g. the model's reply exceeds WhatsApp's body length) so the
    // customer isn't left without a reply.
    const offer = booking?.offer
    let sentInteractive = false
    if (offer && offer.length > 0) {
      const buttons: InteractiveButton[] = offer
        .slice(0, 3)
        .map((slot, i) => ({ id: `booking_slot_${i}`, title: formatLocalHHMM(slot.startsAt) }))
      try {
        await engineSendInteractiveButtons({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          bodyText: text,
          buttons,
        })
        sentInteractive = true
      } catch (err) {
        console.error('[ai auto-reply] booking offer send failed, falling back to text:', err)
      }
    }
    if (!sentInteractive) {
      try {
        await engineSendText({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          text,
          aiGenerated: true,
        })
      } catch (err) {
        // The claimed slot never turned into a delivered message — give it
        // back so a transient send failure (or a bug like the BSUID `to`
        // rejection) doesn't permanently cap this conversation's auto-reply
        // budget. Best-effort: if the release itself fails we just under-
        // reply on a later inbound instead of crashing here.
        console.error('[ai auto-reply] text send failed, releasing claimed reply slot:', err)
        try {
          await db.rpc('release_ai_reply_slot', { conversation_id: conversationId })
        } catch (releaseErr) {
          console.error('[ai auto-reply] release_ai_reply_slot failed:', releaseErr)
        }
        return
      }
    }

    // Anchor for the next reply-delay wait (see the check near the top of
    // this function) — best-effort, never blocks the reply that already
    // landed.
    try {
      await db
        .from('conversations')
        .update({ last_ai_reply_at: new Date().toISOString() })
        .eq('id', conversationId)
    } catch (err) {
      console.error('[ai auto-reply] last_ai_reply_at update failed:', err)
    }

    // Dispatch any attachment(s) the model selected via send_attachment,
    // after the text — best-effort: a failed media send shouldn't undo
    // the text reply that already landed. When the catalog entry has a
    // price, send it as a full product card (caption on the WhatsApp
    // media itself, plus structured metadata so the inbox thread renders
    // the enriched card) instead of a bare image/file.
    for (const attachment of attachments) {
      try {
        const isProduct = attachment.price != null
        const caption = isProduct
          ? [
              attachment.name,
              attachment.description,
              `${attachment.currency ?? ''} ${attachment.price}`.trim(),
            ]
              .filter(Boolean)
              .join('\n')
          : attachment.name
        const metadata: ProductCardMetadata | undefined = isProduct
          ? {
              kind: 'product_card',
              name: attachment.name,
              price: attachment.price,
              currency: attachment.currency,
              description: attachment.description,
            }
          : undefined
        await engineSendMedia({
          accountId,
          userId: configOwnerUserId,
          conversationId,
          contactId,
          kind: attachment.kind,
          link: attachment.mediaUrl,
          filename: attachment.filename,
          caption,
          metadata,
        })
      } catch (err) {
        console.error('[ai auto-reply] attachment send failed:', err)
      }
    }

    // Persist an appointment confirmed via book_appointment — best-effort,
    // same rationale as the attachment dispatch above: the customer-facing
    // text already landed, so a failure here must not surface to them.
    if (booking?.appointment) {
      try {
        await insertAiBooking(db, {
          accountId,
          contactId,
          conversationId,
          appointment: booking.appointment,
        })
      } catch (err) {
        console.error('[ai auto-reply] booking insert failed:', err)
      }
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}
