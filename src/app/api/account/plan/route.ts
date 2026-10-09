// ============================================================
// GET /api/account/plan  (any member, migration 074)
//
// The caller's plan for Configuración → Mi plan, the expiry banner and
// the suspended screen: plan, state, days left, limits, usage, active
// extras and the WhatsApp link to upgrade.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { activeExtras } from '@/lib/plans/limits'
import { loadPlanSnapshot, loadUsage } from '@/lib/plans/server'
import { upgradeUrl } from '@/lib/plans/types'

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount()
    const snapshot = await loadPlanSnapshot(accountId)
    const usage = snapshot.plan
      ? await loadUsage(supabaseAdmin(), accountId)
      : null
    const plan = snapshot.plan

    return NextResponse.json({
      migrated: snapshot.migrated,
      plan: plan
        ? {
            name: plan.name,
            description: plan.description,
            price: plan.price,
            currency: plan.currency,
            billing_interval: plan.billing_interval,
          }
        : null,
      status: snapshot.status,
      state: snapshot.state.state,
      days_left: snapshot.state.daysLeft,
      suspends_at: snapshot.state.suspendsAt,
      expires_at: snapshot.expiresAt,
      limits: snapshot.limits,
      usage,
      extras: activeExtras(snapshot.extras).map((e) => ({
        id: e.id,
        resource: e.resource,
        quantity: e.quantity,
        module_key: e.module_key,
        expires_at: e.expires_at,
      })),
      upgrade_url: upgradeUrl(snapshot.accountName, plan?.name ?? null),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
