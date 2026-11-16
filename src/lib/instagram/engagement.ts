import type { SupabaseClient } from '@supabase/supabase-js'
import { accountModuleEnabled } from '@/lib/modules-server'
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events'
import type { MessengerProfileInput } from './api'
import type { InstagramConnection } from './connection'
import { deliverRuleContent, followGate, loadKeywordRules } from './comments'
import { pickMessageRule, type KeywordRule } from './keywords'
import { instagramEngineSendText } from './send'
import { loadInstagramSettings, type InstagramSettings } from './settings'

// ============================================================
// Phase 4 (module `instagram_engagement`, migration 082): what happens in
// the chat beyond comments.
//   * Story mentions get the owner's thanks (settings.mention_thanks).
//   * Story replies and DMs fire the keyword rules whose `triggers`
//     include them; the window is open, so the content goes at once.
//   * Ice breakers (IGICE:<i>) and the persistent menu (IGMENU:<i>): a
//     linked rule delivers its content, a link is sent, "ai" lets the
//     agent answer the question.
// ============================================================

export const ICE_PREFIX = 'IGICE:'
export const MENU_PREFIX = 'IGMENU:'

/** The ice breakers and menu as Instagram's Messenger Profile wants them. Pure. */
export function profileInput(settings: Pick<InstagramSettings, 'ice_breakers' | 'menu'>): MessengerProfileInput {
  return {
    iceBreakers: settings.ice_breakers.map((b, i) => ({ question: b.question, payload: `${ICE_PREFIX}${i}` })),
    menu: settings.menu.map((m, i) =>
      m.kind === 'url' && m.url ? { title: m.title, url: m.url } : { title: m.title, payload: `${MENU_PREFIX}${i}` },
    ),
  }
}

/** IGICE:2 / IGMENU:0 → which item. Pure. */
export function parseEngagementPayload(payload: string | null | undefined): { kind: 'ice' | 'menu'; index: number } | null {
  if (!payload) return null
  const m = /^IG(ICE|MENU):(\d+)$/.exec(payload)
  if (!m) return null
  return { kind: m[1] === 'ICE' ? 'ice' : 'menu', index: Number(m[2]) }
}

/** What an ice breaker or menu tap does. Pure. */
export function resolveEngagementTap(
  settings: Pick<InstagramSettings, 'ice_breakers' | 'menu'>,
  payload: string | null | undefined,
): { action: 'rule'; ruleId: string } | { action: 'url'; url: string; title: string } | { action: 'ai' } | null {
  const tap = parseEngagementPayload(payload)
  if (!tap) return null
  if (tap.kind === 'ice') {
    const item = settings.ice_breakers[tap.index]
    if (!item) return { action: 'ai' }
    return item.rule_id ? { action: 'rule', ruleId: item.rule_id } : { action: 'ai' }
  }
  const item = settings.menu[tap.index]
  if (!item) return { action: 'ai' }
  if (item.kind === 'rule' && item.rule_id) return { action: 'rule', ruleId: item.rule_id }
  if (item.kind === 'url' && item.url) return { action: 'url', url: item.url, title: item.title }
  return { action: 'ai' }
}

export interface EngagementOutcome {
  /** The message was answered here; flows/automations/AI skip it. */
  handled: boolean
  /** An ice breaker or menu item for the AI: let it answer even though it is a tap. */
  letAiAnswer: boolean
}

const NOTHING: EngagementOutcome = { handled: false, letAiAnswer: false }

/**
 * Runs phase 4 on one inbound DM. Best-effort: anything failing falls
 * back to the normal pipeline (flows, automations, the AI).
 */
export async function handleEngagementInbound(
  db: SupabaseClient,
  conn: InstagramConnection,
  args: {
    igsid: string
    contactId: string
    conversationId: string
    mid: string
    /** What the customer typed (no notes); null for taps. */
    customerText: string | null
    interactiveReplyId: string | null
    sourceType: string | null
    sourceId: string | null
  },
): Promise<EngagementOutcome> {
  try {
    if (!(await accountModuleEnabled(db, conn.accountId, 'instagram_engagement'))) return NOTHING
    const settings = await loadInstagramSettings(db, conn.accountId)
    const base = { accountId: conn.accountId, conversationId: args.conversationId, contactId: args.contactId }

    // Ice breakers and the menu.
    const tap = resolveEngagementTap(settings, args.interactiveReplyId)
    if (tap) {
      if (tap.action === 'ai') return { handled: false, letAiAnswer: true }
      if (tap.action === 'url') {
        await instagramEngineSendText({ ...base, text: `${tap.title}\n${tap.url}` })
        return { handled: true, letAiAnswer: false }
      }
      const rules = await loadKeywordRules(db, conn.accountId)
      const rule = rules.find((r) => r.id === tap.ruleId && r.active)
      if (!rule) return { handled: false, letAiAnswer: true }
      await runRule(db, conn, rule, base, args.igsid, settings)
      return { handled: true, letAiAnswer: false }
    }
    if (args.interactiveReplyId) return NOTHING

    // A story mention: the thanks, unless they also wrote something.
    if (args.sourceType === 'story_mention' && !args.customerText?.trim()) {
      if (!settings.mention_thanks) return NOTHING
      await instagramEngineSendText({ ...base, text: settings.mention_thanks })
      await logEngagement(db, conn.accountId, args, null, 'mention')
      return { handled: true, letAiAnswer: false }
    }

    // Keyword rules on story replies and DMs.
    const text = args.customerText?.trim() ?? ''
    const trigger = args.sourceType === 'story_reply' ? 'story_replies' : 'dms'
    if (!text && trigger === 'dms') return NOTHING
    const rules = await loadKeywordRules(db, conn.accountId)
    const hit = pickMessageRule(rules, text, trigger)
    if (!hit) return NOTHING
    await runRule(db, conn, hit.rule, base, args.igsid, settings)
    await logEngagement(db, conn.accountId, args, hit.rule.id, trigger === 'story_replies' ? 'story_reply' : 'dm')
    return { handled: true, letAiAnswer: false }
  } catch (err) {
    console.error('[instagram] engagement handling failed:', err)
    return NOTHING
  }
}

export async function runRule(
  db: SupabaseClient,
  conn: InstagramConnection,
  rule: KeywordRule,
  base: { accountId: string; conversationId: string; contactId: string },
  igsid: string,
  settings: InstagramSettings,
): Promise<void> {
  if (rule.require_follow && (await followGate(conn.accessToken, igsid, rule, base, settings.follow_gate_text))) return
  await deliverRuleContent(db, rule, base)
  if (rule.tag_id) {
    await addContactTagAndDispatch({
      db,
      accountId: conn.accountId,
      contactId: base.contactId,
      tagId: rule.tag_id,
      context: { conversation_id: base.conversationId },
    }).catch((err) => console.error('[instagram] tagging the contact failed:', err))
  }
}

/**
 * Story replies, DM keywords and mentions go into the comment log too
 * (`source`), so the Comentarios tab and the reports see them. Needs
 * migration 082; before it nothing is logged.
 */
async function logEngagement(
  db: SupabaseClient,
  accountId: string,
  args: { igsid: string; contactId: string; conversationId: string; mid: string; customerText: string | null; sourceId: string | null },
  ruleId: string | null,
  source: 'story_reply' | 'dm' | 'mention',
): Promise<void> {
  const { error } = await db.from('instagram_comments').insert({
    account_id: accountId,
    comment_id: `dm:${args.mid}`,
    media_id: source === 'story_reply' ? args.sourceId : null,
    igsid: args.igsid,
    text: args.customerText ?? '',
    rule_id: ruleId,
    status: 'replied',
    dm_status: 'delivered',
    contact_id: args.contactId,
    conversation_id: args.conversationId,
    source,
  })
  if (error && error.code !== '23505' && error.code !== 'PGRST204' && error.code !== '42703') {
    console.error('[instagram] logging the story/DM rule failed:', error)
  }
}
