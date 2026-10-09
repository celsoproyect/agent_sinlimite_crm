// ============================================================
// Plan alerts (migration 074), run hourly by server-schedulers.
//
// For every account with a plan:
//   - 80% and 100% of each limit (monthly ones once per business month,
//     the others once per limit value, so raising the limit re-arms them);
//   - the plan about to expire, past due, and suspended.
// Each alert is claimed in `plan_alerts` before it is sent, so it goes
// out once even with several server processes. It lands as a
// `plan_alert` notification for the client's owners/admins and for every
// super admin.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { businessDate, businessToday } from '@/lib/business-timezone'
import { withoutSupportVisitors } from '@/lib/support/sessions'
import { usageAlertKey } from './limits'
import { isMissingSchema, loadPlanSnapshot, loadUsage, type PlanSnapshot } from './server'
import { PLAN_RESOURCES, type PlanResource, type Usage } from './types'

const RESOURCE_LABEL: Record<PlanResource, string> = {
  ai_replies: 'respuestas de IA este mes',
  users: 'usuarios',
  contacts: 'contactos',
  broadcasts: 'difusiones este mes',
  kb_documents: 'documentos de conocimiento',
}

export interface PlanAlert {
  key: string
  /** For the client's team. */
  title: string
  body: string
  /** For the super admins (names the account). */
  adminTitle: string
}

function day(iso: string): string {
  const [y, m, d] = businessDate(new Date(new Date(iso).getTime() - 1)).split('-')
  return `${d}/${m}/${y}`
}

/** The alerts an account is due right now (pure apart from the clock). */
export function dueAlerts(
  snapshot: PlanSnapshot,
  usage: Usage,
  now: Date = new Date(),
): PlanAlert[] {
  if (!snapshot.plan) return []
  const name = snapshot.accountName || 'Cuenta'
  const alerts: PlanAlert[] = []
  const monthKey = businessToday(now).slice(0, 7)

  for (const resource of PLAN_RESOURCES) {
    const limit = snapshot.limits[resource]
    if (limit === null || limit <= 0) continue
    const used = usage[resource]
    const label = RESOURCE_LABEL[resource]
    if (used >= limit) {
      alerts.push({
        key: usageAlertKey(resource, 100, limit, monthKey),
        title: `Llegaste al límite de ${label}`,
        body: `Usaste ${used} de ${limit} ${label} del plan ${snapshot.plan.name}. Mejora el plan para seguir sin interrupciones.`,
        adminTitle: `${name} llegó al límite de ${label} (${used}/${limit})`,
      })
    } else if (used >= limit * 0.8) {
      alerts.push({
        key: usageAlertKey(resource, 80, limit, monthKey),
        title: `Vas por el 80% de ${label}`,
        body: `Usaste ${used} de ${limit} ${label} del plan ${snapshot.plan.name}.`,
        adminTitle: `${name} va por el 80% de ${label} (${used}/${limit})`,
      })
    }
  }

  const { state } = snapshot.state
  const expires = snapshot.expiresAt
  // Keyed by the date, so each new paid period re-arms them.
  const dateKey = expires ? expires.slice(0, 10) : 'none'
  if (state === 'expiring' && expires) {
    alerts.push({
      key: `expiring:${dateKey}`,
      title: 'Tu plan vence pronto',
      body: `El plan ${snapshot.plan.name} está pagado hasta el ${day(expires)}. Renuévalo para no perder el servicio.`,
      adminTitle: `El plan de ${name} vence el ${day(expires)}`,
    })
  } else if (state === 'trial' && expires && snapshot.state.daysLeft !== null && snapshot.state.daysLeft <= 3) {
    alerts.push({
      key: `trial_ending:${dateKey}`,
      title: 'Tu prueba termina pronto',
      body: `La prueba termina el ${day(expires)}. Escríbenos para activar tu plan.`,
      adminTitle: `La prueba de ${name} termina el ${day(expires)}`,
    })
  } else if (state === 'past_due' && expires) {
    alerts.push({
      key: `past_due:${dateKey}`,
      title: 'Tu plan venció',
      body: `El plan ${snapshot.plan.name} venció el ${day(expires)}. La cuenta se suspenderá si no se renueva.`,
      adminTitle: `El plan de ${name} venció el ${day(expires)} (sin pagar)`,
    })
  } else if (state === 'suspended') {
    alerts.push({
      key: `suspended:${dateKey}`,
      title: 'Cuenta suspendida',
      body: 'La IA, las difusiones y las invitaciones están pausadas. Los mensajes de tus clientes se siguen guardando.',
      adminTitle: `${name} quedó suspendida`,
    })
  }
  return alerts
}

/** Super admins, each with the account they should see the alert in. */
async function superAdminRecipients(
  admin: SupabaseClient,
): Promise<{ user_id: string; account_id: string }[]> {
  const { data, error } = await admin
    .from('profiles')
    .select('user_id, account_id')
    .eq('is_super_admin', true)
  if (error || !data) return []
  const rows = data as { user_id: string; account_id: string | null }[]
  // In support mode the profile sits in a client's account; the alert
  // belongs in their own one.
  const { data: sessions } = await admin
    .from('support_sessions')
    .select('user_id, home_account_id')
    .is('ended_at', null)
  const home = new Map(
    ((sessions as { user_id: string; home_account_id: string }[] | null) ?? []).map((s) => [
      s.user_id,
      s.home_account_id,
    ]),
  )
  return rows
    .map((r) => ({ user_id: r.user_id, account_id: home.get(r.user_id) ?? r.account_id ?? '' }))
    .filter((r) => r.account_id)
}

/** Check every account with a plan and send the alerts now due. Returns how many went out. */
export async function checkPlanAlerts(admin: SupabaseClient, now: Date = new Date()): Promise<number> {
  const { data: accounts, error } = await admin
    .from('accounts')
    .select('id')
    .not('plan_id', 'is', null)
  if (error) {
    if (!isMissingSchema(error.code)) console.error('[plan-alerts] accounts load failed:', error.message)
    return 0
  }

  let supers: { user_id: string; account_id: string }[] | null = null
  let sent = 0

  for (const { id } of (accounts ?? []) as { id: string }[]) {
    try {
      const snapshot = await loadPlanSnapshot(id, { fresh: true, db: admin })
      const usage = await loadUsage(admin, id)
      const alerts = dueAlerts(snapshot, usage, now)
      if (alerts.length === 0) continue

      for (const alert of alerts) {
        // Claim it; a conflict means it already went out.
        const { data: claimed, error: claimErr } = await admin
          .from('plan_alerts')
          .upsert({ account_id: id, alert_key: alert.key }, { onConflict: 'account_id,alert_key', ignoreDuplicates: true })
          .select('alert_key')
        if (claimErr) {
          console.error('[plan-alerts] claim failed:', claimErr.message)
          continue
        }
        if (!claimed || claimed.length === 0) continue

        const { data: team } = await admin
          .from('profiles')
          .select('user_id')
          .eq('account_id', id)
          .in('account_role', ['owner', 'admin'])
        const clients = await withoutSupportVisitors(admin, id, (team ?? []) as { user_id: string }[])
        supers ??= await superAdminRecipients(admin)
        const superIds = new Set(supers.map((s) => s.user_id))

        const rows = [
          ...clients
            .filter((c) => !superIds.has(c.user_id))
            .map((c) => ({
              account_id: id,
              user_id: c.user_id,
              type: 'plan_alert',
              title: alert.title,
              body: alert.body,
            })),
          ...supers.map((s) => ({
            account_id: s.account_id,
            user_id: s.user_id,
            type: 'plan_alert',
            title: alert.adminTitle,
            body: alert.body,
          })),
        ]
        if (rows.length === 0) continue
        const { error: insertErr } = await admin.from('notifications').insert(rows)
        if (insertErr) console.error('[plan-alerts] notification insert failed:', insertErr.message)
        else sent += 1
      }
    } catch (err) {
      console.error('[plan-alerts] account check failed:', id, err)
    }
  }
  return sent
}
