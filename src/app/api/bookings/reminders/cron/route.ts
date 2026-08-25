import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { engineSendText, engineSendTemplate } from '@/lib/automations/meta-send'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import {
  renderReminderMessage,
  reminderTemplateParams,
  isOutsideSessionWindowError,
} from '@/lib/bookings/reminder-message'

/**
 * Drain due booking reminders (`get_due_booking_reminders`, migration
 * 052). Meant to be hit on a schedule (external pinger / Vercel Cron),
 * same shared secret as `/api/automations/cron` and `/api/flows/cron`
 * (see docs/docker.md) — no reason to make the operator manage a
 * second secret for a third cron endpoint.
 *
 * Delivery is hybrid: try a free-text send (fully personalized) first;
 * if Meta rejects it for being outside the 24h customer-service window
 * and the rule has a fallback template configured, retry with that
 * template. `booking_reminder_sends` (UNIQUE(booking_id, rule_id)) is
 * the claim/de-dup mechanism so overlapping cron runs never double-send.
 */

interface DueReminderRow {
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
}

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()
  const { data: due, error } = await admin.rpc('get_due_booking_reminders', { p_limit: 50 })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = (due ?? []) as DueReminderRow[]
  if (rows.length === 0) return NextResponse.json({ processed: 0, sent: 0, failed: 0 })

  let processed = 0
  let sent = 0
  let failed = 0

  for (const row of rows) {
    const claim = await claimSend(admin, row)
    if (!claim) continue // already claimed by another run
    processed++

    try {
      const result = await sendReminder(admin, row)
      await admin
        .from('booking_reminder_sends')
        .update({ status: 'sent', channel: result.channel })
        .eq('id', claim.id)
      sent++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await admin
        .from('booking_reminder_sends')
        .update({ status: 'failed', error: message })
        .eq('id', claim.id)
      failed++
    }
  }

  return NextResponse.json({ processed, sent, failed })
}

async function claimSend(
  admin: ReturnType<typeof supabaseAdmin>,
  row: DueReminderRow,
): Promise<{ id: string } | null> {
  const { data, error } = await admin
    .from('booking_reminder_sends')
    .insert({ booking_id: row.booking_id, rule_id: row.rule_id, status: 'pending' })
    .select('id')
    .single()
  if (error) {
    if (!isUniqueViolation(error)) {
      console.error('[bookings/reminders/cron] claim error:', error)
    }
    return null
  }
  return data
}

async function sendReminder(
  admin: ReturnType<typeof supabaseAdmin>,
  row: DueReminderRow,
): Promise<{ channel: 'text' | 'template' }> {
  if (!row.contact_phone) {
    throw new Error('contact has no phone number')
  }

  const conversationId = row.conversation_id
    ? row.conversation_id
    : (
        await resolveConversationByPhone(admin, row.account_id, row.contact_phone, row.contact_name)
      ).conversationId

  const ownerUserId = await resolveAuditUserId(admin, row.account_id).catch((err) => {
    if (err instanceof ContactError) throw new Error(err.message)
    throw err
  })

  const vars = {
    contactName: row.contact_name || row.contact_phone,
    service: row.service || '',
    startsAt: row.starts_at,
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
