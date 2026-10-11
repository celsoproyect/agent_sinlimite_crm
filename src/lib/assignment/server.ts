import type { SupabaseClient } from '@supabase/supabase-js'
import { accountModuleEnabled } from '@/lib/modules-server'
import { sendPushToUsers, sendPushToAccountRoles, trimPushBody } from '@/lib/push/send'
import { notifyOwner } from '@/lib/telegram/send'
import { withoutSupportVisitors } from '@/lib/support/sessions'
import {
  normalizeAssignmentSettings,
  pickAssignee,
  rotationOrder,
  type AssignCandidate,
  type AssignmentReason,
  type AssignmentSettings,
} from './settings'

// ============================================================
// Automatic chat assignment (module `auto_assign`, migration 076):
// picks the teammate, writes the assignment, tells them (in-app +
// push) and moves unanswered chats along (`reassignUnanswered`, every
// minute from server-schedulers.ts). Every function is best-effort and
// never throws: a failed assignment leaves the chat in the shared queue,
// where the owners' handoff alert still finds it.
// ============================================================

/** Postgres "column does not exist" / PostgREST "unknown column". */
function missingColumn(code: string | undefined): boolean {
  return code === '42703' || code === 'PGRST204'
}

/** The account's settings, or null when the module is off, the mode is
 *  off or migration 076 hasn't run. */
export async function loadActiveAssignmentSettings(
  db: SupabaseClient,
  accountId: string,
): Promise<AssignmentSettings | null> {
  try {
    const { data, error } = await db
      .from('accounts')
      .select('assignment_settings')
      .eq('id', accountId)
      .maybeSingle()
    if (error || !data) return null
    const settings = normalizeAssignmentSettings(data.assignment_settings)
    if (settings.mode === 'off') return null
    if (!(await accountModuleEnabled(db, accountId, 'auto_assign'))) return null
    return settings
  } catch {
    return null
  }
}

interface TeamRow {
  user_id: string
  full_name: string | null
  account_role: string
  is_available: boolean | null
  last_auto_assigned_at: string | null
}

export interface RotationMember extends AssignCandidate {
  full_name: string
}

/** Available owners/admins/agents in rotation order, with their turn and
 *  open-chat count. */
export async function loadRotation(
  db: SupabaseClient,
  accountId: string,
  settings: AssignmentSettings,
): Promise<RotationMember[]> {
  const { data, error } = await db
    .from('profiles')
    .select('user_id, full_name, account_role, is_available, last_auto_assigned_at')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
  if (error || !data) return []
  const team = await withoutSupportVisitors(
    db,
    accountId,
    (data as TeamRow[]).filter((p) => p.account_role !== 'viewer' && p.is_available !== false),
  )
  const ordered = rotationOrder(team, settings.members)
  const counts = await Promise.all(
    ordered.map(async (m) => {
      if (settings.mode !== 'least_busy') return 0
      const { count } = await db
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('account_id', accountId)
        .eq('assigned_agent_id', m.user_id)
        .neq('status', 'closed')
      return count ?? 0
    }),
  )
  return ordered.map((m, i) => ({
    user_id: m.user_id,
    full_name: m.full_name || '',
    last_assigned_at: m.last_auto_assigned_at,
    open_chats: counts[i],
  }))
}

const REASON_TITLE: Record<AssignmentReason, (name: string) => string> = {
  requested: (name) => `${name} quiere hablar con un agente humano`,
  missing_info: (name) => `${name}: la IA no tenía la respuesta`,
  new_chat: (name) => `Nuevo chat de ${name}`,
}

export function assignmentTitle(reason: AssignmentReason, contactName: string): string {
  return REASON_TITLE[reason](contactName)
}

/** In-app notification + push for the person who got the chat. */
async function notifyAssignee(
  db: SupabaseClient,
  args: {
    accountId: string
    userId: string
    conversationId: string
    contactId: string
    title: string
    body: string
  },
): Promise<void> {
  try {
    const { error } = await db.from('notifications').insert({
      account_id: args.accountId,
      user_id: args.userId,
      type: 'conversation_assigned',
      conversation_id: args.conversationId,
      contact_id: args.contactId,
      title: args.title,
      body: args.body,
    })
    if (error) console.error('[assignment] notification insert failed:', error.message)
    await sendPushToUsers(
      args.accountId,
      [args.userId],
      {
        title: args.title,
        body: trimPushBody(args.body),
        url: `/inbox?c=${args.conversationId}`,
        tag: `assigned-${args.conversationId}`,
      },
      db,
    )
  } catch (err) {
    console.error('[assignment] notify assignee failed:', err)
  }
}

export interface AssignResult {
  userId: string
  name: string
}

/**
 * Give an unassigned chat to the next teammate. Returns who got it, or
 * null when the module/mode is off, nobody is available, or someone
 * claimed it first.
 */
export async function autoAssignConversation(
  db: SupabaseClient,
  args: {
    accountId: string
    conversationId: string
    contactId: string
    contactName: string
    reason: AssignmentReason
    /** What the assignee reads in the alert (the AI's summary). */
    summary?: string | null
  },
): Promise<AssignResult | null> {
  try {
    const settings = await loadActiveAssignmentSettings(db, args.accountId)
    if (!settings) return null
    const rotation = await loadRotation(db, args.accountId, settings)
    const userId = pickAssignee(settings.mode, rotation)
    if (!userId) return null
    const now = new Date().toISOString()
    const { data, error } = await db
      .from('conversations')
      .update({
        assigned_agent_id: userId,
        locked_at: now,
        auto_assigned: true,
        assignment_attempts: 1,
        assignment_reason: args.reason,
      })
      .eq('id', args.conversationId)
      .is('assigned_agent_id', null)
      .select('id')
    if (error) {
      if (!missingColumn(error.code)) console.error('[assignment] assign failed:', error.message)
      return null
    }
    if (!data?.length) return null // someone took it first
    await db.from('profiles').update({ last_auto_assigned_at: now }).eq('user_id', userId)
    const name = rotation.find((m) => m.user_id === userId)?.full_name || ''
    await notifyAssignee(db, {
      accountId: args.accountId,
      userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      title: assignmentTitle(args.reason, args.contactName),
      body: args.summary?.trim() || 'Abre el chat para atenderlo.',
    })
    return { userId, name }
  } catch (err) {
    console.error('[assignment] auto-assign failed:', err)
    return null
  }
}

/**
 * New chats while the AI isn't answering (setting `assign_when_ai_off`).
 * The caller decides the AI won't reply; this only checks the settings
 * and that nobody owns the chat yet.
 */
export async function assignChatWithoutAi(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; contactId: string },
): Promise<void> {
  try {
    const settings = await loadActiveAssignmentSettings(db, args.accountId)
    if (!settings?.assign_when_ai_off) return
    const { data: conv } = await db
      .from('conversations')
      .select('assigned_agent_id, status, last_message_text, contact:contacts(name, phone)')
      .eq('id', args.conversationId)
      .maybeSingle()
    if (!conv || conv.assigned_agent_id || conv.status === 'closed') return
    const contact = (Array.isArray(conv.contact) ? conv.contact[0] : conv.contact) as
      | { name: string | null; phone: string | null }
      | null
    await autoAssignConversation(db, {
      accountId: args.accountId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      contactName: contact?.name || contact?.phone || 'Un cliente',
      reason: 'new_chat',
      summary: conv.last_message_text ? `Último mensaje: ${conv.last_message_text}` : null,
    })
  } catch (err) {
    console.error('[assignment] new-chat assign failed:', err)
  }
}

interface StaleRow {
  id: string
  contact_id: string
  assigned_agent_id: string
  locked_at: string | null
  assignment_attempts: number
  assignment_reason: AssignmentReason | null
  ai_handoff_summary: string | null
  contact: { name: string | null; phone: string | null } | { name: string | null; phone: string | null }[] | null
}

/** True when a person (not the AI or an automation) wrote in the chat
 *  since `since`. */
async function humanRepliedSince(db: SupabaseClient, conversationId: string, since: string): Promise<boolean> {
  const { data } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .eq('sender_type', 'agent')
    .eq('ai_generated', false)
    .neq('content_type', 'system_event')
    .gte('created_at', since)
    .limit(1)
  return !!data?.length
}

/**
 * Move automatically assigned chats nobody answered within the account's
 * `reassign_minutes` to the next teammate. Once everyone in the rotation
 * had a turn, the owners/admins are told nobody answered and the chat
 * stays with the last person. Returns how many chats moved.
 */
export async function reassignUnanswered(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data: accounts, error } = await db
    .from('accounts')
    .select('id, assignment_settings')
    .not('assignment_settings', 'is', null)
  if (error || !accounts) return 0 // 42703 before migration 076
  let moved = 0
  for (const acct of accounts as { id: string; assignment_settings: unknown }[]) {
    const settings = normalizeAssignmentSettings(acct.assignment_settings)
    if (settings.mode === 'off' || settings.reassign_minutes === null) continue
    if (!(await accountModuleEnabled(db, acct.id, 'auto_assign'))) continue
    const cutoff = new Date(now.getTime() - settings.reassign_minutes * 60_000).toISOString()
    const { data: stale } = await db
      .from('conversations')
      .select(
        'id, contact_id, assigned_agent_id, locked_at, assignment_attempts, assignment_reason, ai_handoff_summary, contact:contacts(name, phone)',
      )
      .eq('account_id', acct.id)
      .eq('auto_assigned', true)
      .not('assigned_agent_id', 'is', null)
      .neq('status', 'closed')
      .lt('locked_at', cutoff)
      .limit(50)
    if (!stale?.length) continue
    const rotation = await loadRotation(db, acct.id, settings)
    for (const conv of stale as StaleRow[]) {
      try {
        if (await moveOne(db, acct.id, settings, rotation, conv, now)) moved++
      } catch (err) {
        console.error('[assignment] reassign failed:', err)
      }
    }
  }
  return moved
}

async function moveOne(
  db: SupabaseClient,
  accountId: string,
  settings: AssignmentSettings,
  rotation: RotationMember[],
  conv: StaleRow,
  now: Date,
): Promise<boolean> {
  const contact = Array.isArray(conv.contact) ? conv.contact[0] : conv.contact
  const contactName = contact?.name || contact?.phone || 'Un cliente'
  // Stop watching: the attempts stay as they are, so this doesn't count
  // as a manual change for the reset trigger.
  const stopWatching = () =>
    db.from('conversations').update({ auto_assigned: false }).eq('id', conv.id).eq('auto_assigned', true)

  if (conv.locked_at && (await humanRepliedSince(db, conv.id, conv.locked_at))) {
    await stopWatching()
    return false
  }

  const previous = rotation.find((m) => m.user_id === conv.assigned_agent_id)?.full_name || 'El agente asignado'
  const next = conv.assignment_attempts >= rotation.length ? null : pickAssignee(settings.mode, rotation, conv.assigned_agent_id)
  if (!next) {
    await stopWatching()
    const text = `⚠️ Nadie ha respondido a ${contactName} después de ${settings.reassign_minutes} min. Sigue asignado a ${previous}.`
    const title = `Nadie ha respondido a ${contactName}`
    await notifyOwner(db, accountId, text)
    const { data: admins } = await db
      .from('profiles')
      .select('user_id')
      .eq('account_id', accountId)
      .in('account_role', ['owner', 'admin'])
    const team = await withoutSupportVisitors(db, accountId, (admins as { user_id: string }[] | null) ?? [])
    if (team.length) {
      await db.from('notifications').insert(
        team.map((a) => ({
          account_id: accountId,
          user_id: a.user_id,
          type: 'handoff_requested',
          conversation_id: conv.id,
          contact_id: conv.contact_id,
          title,
          body: text,
        })),
      )
    }
    await sendPushToAccountRoles(
      accountId,
      ['owner', 'admin'],
      { title, body: text, url: `/inbox?c=${conv.id}`, tag: `unanswered-${conv.id}` },
      db,
    )
    return false
  }

  const stamp = now.toISOString()
  const { data, error } = await db
    .from('conversations')
    .update({
      assigned_agent_id: next,
      locked_at: stamp,
      auto_assigned: true,
      assignment_attempts: conv.assignment_attempts + 1,
    })
    .eq('id', conv.id)
    .eq('assigned_agent_id', conv.assigned_agent_id)
    .eq('auto_assigned', true)
    .select('id')
  if (error || !data?.length) return false
  await db.from('profiles').update({ last_auto_assigned_at: stamp }).eq('user_id', next)
  const reason = conv.assignment_reason ?? 'requested'
  await notifyAssignee(db, {
    accountId,
    userId: next,
    conversationId: conv.id,
    contactId: conv.contact_id,
    title: `Reasignado: ${assignmentTitle(reason, contactName)}`,
    body:
      `${previous} no respondió en ${settings.reassign_minutes} min.` +
      (conv.ai_handoff_summary ? `\n\n${conv.ai_handoff_summary}` : ''),
  })
  return true
}
