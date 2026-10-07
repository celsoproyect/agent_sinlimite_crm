// ============================================================
// Weekly owner summary, sent to the account's Telegram chat every
// Monday morning (business time) for the week that just ended, and on
// demand from Canales → Telegram.
//
// WhatsApp would need an approved Meta template (a business-initiated
// message outside the 24h window), so the automatic send is Telegram
// only.
// ============================================================

import { isModuleEnabled, type EnabledModules } from '@/lib/modules'
import type { SupabaseClient } from '@supabase/supabase-js'
import { businessToday, businessTime, businessWeekday } from '@/lib/business-timezone'
import type { DayRange } from '@/lib/bookings/ranges'
import { sendTelegramMessage } from '@/lib/telegram/send'
import { formatDuration, formatMoney } from './format'
import { loadReportOverview, type ReportOverview } from './overview'
import { presetRange, previousRange } from './range'

/** Monday, from this hour on (business time), the summary goes out. */
export const WEEKLY_REPORT_HOUR = 8

const CHANNEL_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', web: 'Web', other: 'Otros' }

function delta(now: number, before: number): string {
  if (before === 0) return now > 0 ? ' (nuevo)' : ''
  const pct = Math.round(((now - before) / before) * 100)
  return pct === 0 ? ' (=)' : ` (${pct > 0 ? '+' : ''}${pct}%)`
}

function dayLabel(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

export function buildWeeklySummaryText(
  accountName: string,
  week: ReportOverview,
  prev: Pick<ReportOverview, 'messages' | 'conversations' | 'newContacts' | 'sales'>,
): string {
  const c = week.conversations
  const lines = [
    `📊 Resumen semanal — ${accountName}`,
    `Semana ${dayLabel(week.range.from)} al ${dayLabel(week.range.to)}`,
    '',
    `💬 Conversaciones: ${c.total}${delta(c.total, prev.conversations.total)}`,
    `🤖 Atendidas solo por la IA: ${c.aiOnly}${c.aiRate != null ? ` (${c.aiRate}%)` : ''}`,
    `👤 Con intervención humana: ${c.withHuman}`,
    `✉️ Mensajes de la IA: ${week.messages.ai}${delta(week.messages.ai, prev.messages.ai)} · de personas: ${week.messages.human}`,
    `⏱️ Respuesta típica (mediana): IA ${formatDuration(week.responseTime.ai.medianSeconds)} · personas ${formatDuration(week.responseTime.human.medianSeconds)}`,
    '',
    `🆕 Contactos nuevos: ${week.newContacts.total}${delta(week.newContacts.total, prev.newContacts.total)}`,
  ]
  const byCh = Object.entries(week.newContacts.byChannel)
  if (byCh.length) lines.push(`   ${byCh.map(([ch, n]) => `${CHANNEL_LABEL[ch] ?? ch}: ${n}`).join(' · ')}`)
  lines.push(
    `📅 Citas agendadas: ${week.bookings.total} (por la IA: ${week.bookings.byAi})`,
    '',
    `💰 Ventas ganadas: ${week.sales.won.count} — ${formatMoney(week.sales.won.totals)}${delta(week.sales.won.count, prev.sales.won.count)}`,
  )
  for (const [ch, b] of Object.entries(week.sales.byChannel)) {
    lines.push(`   ${CHANNEL_LABEL[ch] ?? ch}: ${b.count} — ${formatMoney(b.totals)}`)
  }
  lines.push(`🤖 Ventas donde participó la IA: ${week.sales.aiAssisted.count} — ${formatMoney(week.sales.aiAssisted.totals)}`)
  return lines.join('\n')
}

/** The Monday–Sunday week before the one containing `today`. */
export function lastWeekRange(today: string = businessToday()): DayRange {
  return presetRange('lastWeek', today)
}

export async function buildWeeklySummary(
  db: SupabaseClient,
  accountId: string,
  accountName: string,
  range: DayRange = lastWeekRange(),
): Promise<string> {
  const [week, prev] = await Promise.all([
    loadReportOverview(db, accountId, range, 'all'),
    loadReportOverview(db, accountId, previousRange(range), 'all'),
  ])
  return buildWeeklySummaryText(accountName, week, prev)
}

interface AccountRow {
  id: string
  name: string
  telegram_bot_token: string | null
  telegram_chat_id: string | null
  weekly_report_enabled: boolean | null
  weekly_report_sent_at: string | null
  enabled_modules: EnabledModules | null
}

/** Due when it's Monday from WEEKLY_REPORT_HOUR on and nothing went out today. */
export function weeklySummaryDue(now: Date, sentAt: string | null): boolean {
  const today = businessToday(now)
  if (businessWeekday(today) !== 1) return false
  if (Number(businessTime(now).slice(0, 2)) < WEEKLY_REPORT_HOUR) return false
  return !sentAt || businessToday(new Date(sentAt)) !== today
}

/**
 * Send the summary to every account that has Telegram set up and the
 * weekly report on. Called every 15 minutes by the server scheduler. Skips
 * everything when migration 065 hasn't run (no `weekly_report_sent_at`
 * to dedupe on, so it would send on every check).
 */
export async function sendDueWeeklySummaries(db: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data, error } = await db
    .from('accounts')
    .select('id, name, telegram_bot_token, telegram_chat_id, weekly_report_enabled, weekly_report_sent_at, enabled_modules')
    .not('telegram_bot_token', 'is', null)
    .not('telegram_chat_id', 'is', null)
  if (error) {
    if (error.code === '42703') return 0
    throw error
  }

  let sent = 0
  for (const acc of (data ?? []) as AccountRow[]) {
    if (acc.weekly_report_enabled === false) continue
    if (!isModuleEnabled(acc.enabled_modules, 'weekly_summary')) continue
    if (!weeklySummaryDue(now, acc.weekly_report_sent_at)) continue
    try {
      // Claim first so a slow send or a second instance can't double-send.
      const claim = db
        .from('accounts')
        .update({ weekly_report_sent_at: now.toISOString() })
        .eq('id', acc.id)
      const { data: claimed } = await (acc.weekly_report_sent_at
        ? claim.eq('weekly_report_sent_at', acc.weekly_report_sent_at)
        : claim.is('weekly_report_sent_at', null)
      ).select('id')
      if (!claimed?.length) continue
      const text = await buildWeeklySummary(db, acc.id, acc.name, lastWeekRange(businessToday(now)))
      await sendTelegramMessage({ botToken: acc.telegram_bot_token!, chatId: acc.telegram_chat_id!, text })
      sent += 1
    } catch (err) {
      console.error('[weekly-summary] send failed for account', acc.id, err)
    }
  }
  return sent
}
