import type { SupabaseClient } from '@supabase/supabase-js'
import { engineSendText, engineSendTemplate } from '@/lib/automations/meta-send'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { bookingReference } from '@/lib/bookings/reference'
import {
  renderReminderMessage,
  reminderTemplateParams,
  isOutsideSessionWindowError,
  usesToken,
  type ReminderMessageVars,
} from '@/lib/bookings/reminder-message'

/**
 * Drain due booking reminders (`get_due_booking_reminders`, migration
 * 052/062). Called by `/api/bookings/reminders/cron` (external pinger)
 * and by the in-process scheduler started from `instrumentation.ts`.
 *
 * Delivery is hybrid: try a free-text send (fully personalized) first;
 * if Meta rejects it for being outside the 24h customer-service window
 * and the rule has a fallback template configured, retry with that
 * template. `booking_reminder_sends` (UNIQUE(booking_id, rule_id)) is
 * the claim/de-dup mechanism so overlapping runs never double-send.
 */

export interface DueReminderRow {
  booking_id: string
  account_id: string
  contact_id: string
  conversation_id: string | null
  service: string
  starts_at: string
  contact_name: string | null
  contact_phone: string | null
  rule_id: string
  offset_minutes: number
  message_text: string
  template_name: string | null
  template_language: string | null
  /** Migration 068 (absent before it): what was booked, and whether the
   *  rule is a reminder (before) or a follow-up (after). */
  booking_kind?: 'appointment' | 'table' | 'event' | null
  rule_kind?: 'before' | 'after' | null
  party_size?: number | null
}

export interface DrainResult {
  processed: number
  sent: number
  failed: number
}

export async function drainBookingReminders(admin: SupabaseClient, limit = 50): Promise<DrainResult> {
  const { data: due, error } = await admin.rpc('get_due_booking_reminders', { p_limit: limit })
  if (error) throw new Error(error.message)

  const rows = (due ?? []) as DueReminderRow[]
  const result: DrainResult = { processed: 0, sent: 0, failed: 0 }

  for (const row of rows) {
    const claim = await claimSend(admin, row)
    if (!claim) continue // already claimed by another run
    result.processed++

    try {
      const sent = await sendReminder(admin, row)
      await admin
        .from('booking_reminder_sends')
        .update({ status: 'sent', channel: sent.channel })
        .eq('id', claim.id)
      result.sent++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await admin
        .from('booking_reminder_sends')
        .update({ status: 'failed', error: message })
        .eq('id', claim.id)
      result.failed++
    }
  }

  return result
}

async function claimSend(admin: SupabaseClient, row: DueReminderRow): Promise<{ id: string } | null> {
  const { data, error } = await admin
    .from('booking_reminder_sends')
    .insert({ booking_id: row.booking_id, rule_id: row.rule_id, status: 'pending' })
    .select('id')
    .single()
  if (error) {
    if (!isUniqueViolation(error)) {
      console.error('[bookings/reminders] claim error:', error)
    }
    return null
  }
  return data
}

/** The booking's doctor (clinic module), for {{doctor}}. Undefined when
 *  it has none or migration 066 hasn't run. */
async function bookingDoctorName(admin: SupabaseClient, bookingId: string): Promise<string | undefined> {
  const { data, error } = await admin
    .from('bookings')
    .select('professional:professionals(name)')
    .eq('id', bookingId)
    .maybeSingle()
  if (error || !data) return undefined
  const professional = (data as unknown as { professional?: { name?: string } | null }).professional
  return professional?.name || undefined
}

/** Restaurant/events tokens ({{tables}}, {{hall}}, {{deposit}}), loaded
 *  only when the message uses them. Best-effort: blank on any error. */
async function venueVars(admin: SupabaseClient, row: DueReminderRow): Promise<Partial<ReminderMessageVars>> {
  const out: Partial<ReminderMessageVars> = { partySize: row.party_size ?? null }
  if (row.booking_kind === 'table' && usesToken(row.message_text, 'tables')) {
    const { data } = await admin
      .from('booking_tables')
      .select('table:restaurant_tables(name)')
      .eq('booking_id', row.booking_id)
    const names = ((data ?? []) as unknown as { table?: { name?: string } | null }[])
      .map((r) => r.table?.name)
      .filter((n): n is string => !!n)
    if (names.length) out.tables = names.join(' + ')
  }
  if (row.booking_kind === 'event' && (usesToken(row.message_text, 'hall') || usesToken(row.message_text, 'deposit'))) {
    const { data } = await admin
      .from('bookings')
      .select('deposit_amount, currency, hall:event_halls(name)')
      .eq('id', row.booking_id)
      .maybeSingle()
    const b = data as unknown as { deposit_amount?: number | null; currency?: string | null; hall?: { name?: string } | null } | null
    if (b?.hall?.name) out.hall = b.hall.name
    if (b?.deposit_amount != null) {
      out.deposit = `${b.currency || 'DOP'} ${Number(b.deposit_amount).toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    }
  }
  return out
}

async function sendReminder(
  admin: SupabaseClient,
  row: DueReminderRow,
): Promise<{ channel: 'text' | 'template' }> {
  // A booking made in a WhatsApp conversation is answered in that same
  // conversation, which also reaches username-only WhatsApp users who
  // have no phone number on file. A phone is only needed to open a
  // conversation for a booking that has none.
  let conversationId = row.conversation_id
  if (!conversationId) {
    if (!row.contact_phone) throw new Error('contact has no phone number')
    conversationId = (
      await resolveConversationByPhone(admin, row.account_id, row.contact_phone, row.contact_name)
    ).conversationId
  }

  const ownerUserId = await resolveAuditUserId(admin, row.account_id).catch((err) => {
    if (err instanceof ContactError) throw new Error(err.message)
    throw err
  })

  const vars: ReminderMessageVars = {
    contactName: row.contact_name || row.contact_phone || '',
    service: row.service || '',
    startsAt: row.starts_at,
    reference: bookingReference(row.booking_id, row.booking_kind),
    doctor: usesToken(row.message_text, 'doctor') ? await bookingDoctorName(admin, row.booking_id) : undefined,
    ...(row.booking_kind && row.booking_kind !== 'appointment' ? await venueVars(admin, row) : {}),
  }

  try {
    await engineSendText({
      accountId: row.account_id,
      userId: ownerUserId,
      conversationId,
      contactId: row.contact_id,
      text: renderReminderMessage(row.message_text, vars),
    })
    return { channel: 'text' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!isOutsideSessionWindowError(message) || !row.template_name) {
      throw err instanceof Error ? err : new Error(message)
    }
  }

  await engineSendTemplate({
    accountId: row.account_id,
    userId: ownerUserId,
    conversationId,
    contactId: row.contact_id,
    templateName: row.template_name,
    language: row.template_language ?? undefined,
    params: reminderTemplateParams(vars),
  })
  return { channel: 'template' }
}

/**
 * Drain reminders every minute from inside the server process, so they
 * fire without an external cron. Started once per process from
 * `instrumentation.ts`; disabled with BOOKING_REMINDERS_INTERVAL=off.
 * Overlapping runs (several replicas, or the external cron as well) are
 * safe: the send claim is unique per booking and rule.
 */
export function startBookingReminderScheduler(getAdmin: () => SupabaseClient) {
  const raw = process.env.BOOKING_REMINDERS_INTERVAL
  if (raw === 'off' || raw === '0') return
  const seconds = Number(raw) > 0 ? Number(raw) : 60

  const g = globalThis as { __bookingReminderTimer?: ReturnType<typeof setInterval> }
  if (g.__bookingReminderTimer) return

  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const result = await drainBookingReminders(getAdmin())
      if (result.processed > 0) console.log('[bookings/reminders] drained', result)
    } catch (err) {
      console.error('[bookings/reminders] scheduled run failed:', err)
    } finally {
      running = false
    }
  }
  g.__bookingReminderTimer = setInterval(tick, seconds * 1000)
  g.__bookingReminderTimer.unref?.()
}
