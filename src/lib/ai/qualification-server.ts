import type { SupabaseClient } from '@supabase/supabase-js'
import { accountModuleEnabled } from '@/lib/modules-server'
import { notifyOwner } from '@/lib/telegram/send'
import type { QualificationPromptOptions } from './defaults'
import {
  becameHot,
  formatKnownQualification,
  formatQualificationBlock,
  mergeQualification,
  qualificationQuestionList,
  type Qualification,
} from './qualification'

// Server side of lead prequalification (module `ai_qualification`):
// loading what's stored, the prompt options, and persisting what the
// model reported. Shared by the WhatsApp auto-reply and the widget.

function isMissingColumn(code: string | undefined): boolean {
  return code === '42703' || code === 'PGRST204'
}

export interface QualificationContext {
  qualification: Qualification | null
  /** False before migration 075: the qualification goes to a note and
   *  the profile name is never re-confirmed (nothing could record it). */
  migrated: boolean
  questions: string | null
}

/** Null when the module is off for the account. */
export async function loadQualificationContext(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<QualificationContext | null> {
  if (!(await accountModuleEnabled(db, accountId, 'ai_qualification'))) return null
  const [contact, config] = await Promise.all([
    db.from('contacts').select('qualification').eq('id', contactId).maybeSingle(),
    db.from('ai_configs').select('qualification_questions').eq('account_id', accountId).maybeSingle(),
  ])
  let migrated = true
  let qualification: Qualification | null = null
  if (contact.error) {
    migrated = !isMissingColumn(contact.error.code)
    if (migrated) console.error('[qualification] load failed:', contact.error)
  } else {
    const raw = (contact.data as { qualification?: unknown } | null)?.qualification
    if (raw && typeof raw === 'object') qualification = raw as Qualification
  }
  let questions: string | null = null
  if (config.error) {
    if (!isMissingColumn(config.error.code)) console.error('[qualification] questions load failed:', config.error)
  } else {
    const value = (config.data as { qualification_questions?: string | null } | null)?.qualification_questions
    questions = value && value.trim() ? value : null
  }
  return { qualification, migrated, questions }
}

/**
 * Whether the agent must still get (or confirm) the name, and the prompt
 * options. `hasRealName` = the contact has a name that isn't a
 * placeholder (phone, "Visitante web"). `confirmProfileName` = that name
 * may come from the WhatsApp profile, so the agent confirms it once (a
 * widget visitor typed theirs).
 */
export function qualificationPrompt(
  ctx: QualificationContext,
  contactName: string | null | undefined,
  hasRealName: boolean,
  confirmProfileName = true,
): { needsName: boolean; options: QualificationPromptOptions } {
  const unconfirmed =
    confirmProfileName && hasRealName && ctx.migrated && ctx.qualification?.name_confirmed !== true
  return {
    needsName: !hasRealName || unconfirmed,
    options: {
      questions: qualificationQuestionList(ctx.questions),
      known: formatKnownQualification(ctx.qualification),
      unconfirmedName: unconfirmed ? (contactName ?? null) : null,
    },
  }
}

/**
 * Merge and store what the model reported this turn (plus the name
 * confirmation), and alert the owner by Telegram the first time a lead
 * turns hot (skipped on a handoff, whose own alert carries the block).
 * Returns the merged qualification, or the stored one when nothing
 * changed. Never throws.
 */
export async function applyQualificationCapture(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    ctx: QualificationContext
    captured?: Qualification
    nameCaptured: boolean
    contactName: string
    channel: string
    handoff: boolean
  },
): Promise<Qualification | null> {
  const { accountId, contactId, ctx, captured, nameCaptured, contactName, channel, handoff } = args
  if (!captured && !nameCaptured) return ctx.qualification
  const merged = mergeQualification(ctx.qualification, {
    ...(captured ?? {}),
    ...(nameCaptured ? { name_confirmed: true } : {}),
  })
  try {
    let saved = false
    if (ctx.migrated) {
      const { data, error } = await db
        .from('contacts')
        .update({ qualification: merged, qualified_at: merged.updated_at })
        .eq('id', contactId)
        .select('id')
      if (error && !isMissingColumn(error.code)) console.error('[qualification] save failed:', error)
      saved = !error && !!data && data.length > 0
    }
    // Before migration 075, keep what the customer said as a note.
    const block = captured ? formatQualificationBlock(merged) : ''
    if (!saved && block) {
      await db.from('contact_notes').insert({
        contact_id: contactId,
        account_id: accountId,
        user_id: null,
        note_text: block,
        source: 'ai',
      })
    }
  } catch (err) {
    console.error('[qualification] save failed:', err)
  }
  if (!handoff && becameHot(ctx.qualification, merged)) {
    await notifyOwner(
      db,
      accountId,
      `🔥 Lead caliente (${channel}): ${contactName}\n\n${formatQualificationBlock(merged, contactName)}`,
    )
  }
  return merged
}
