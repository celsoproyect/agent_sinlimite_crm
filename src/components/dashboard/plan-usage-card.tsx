'use client'

import Link from 'next/link'
import { ArrowRight, Gauge } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { UsageBar } from '@/components/plans/usage-bar'
import { useAccountPlan } from '@/hooks/use-account-plan'
import { useCan } from '@/hooks/use-can'
import { MONTHLY_RESOURCES, PLAN_RESOURCES } from '@/lib/plans/types'

/**
 * Dashboard card for owners/admins with this month's usage of the
 * monthly resources (AI replies, broadcasts): what's left, when it
 * renews and, at this pace, when it runs out. Hidden when the account
 * has no plan (no limits) or before migration 074.
 */
export function PlanUsageCard() {
  const t = useTranslations('Dashboard.planUsage')
  const tPlan = useTranslations('Plan')
  const canManage = useCan('manage-members')
  const { info } = useAccountPlan()

  if (!canManage || !info?.migrated || !info.plan || !info.usage) return null
  const usage = info.usage
  const resources = PLAN_RESOURCES.filter((r) => MONTHLY_RESOURCES.has(r))

  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
          <Gauge className="size-4 text-primary" />
          {t('title')}
        </h3>
        <Link
          href="/settings?tab=plan"
          className="inline-flex shrink-0 items-center gap-1 py-2 text-xs font-medium text-primary hover:underline"
        >
          {t('viewPlan')}
          <ArrowRight className="size-3" />
        </Link>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {resources.map((r) => (
          <UsageBar
            key={r}
            label={tPlan(`resources.${r}`)}
            used={usage[r]}
            limit={info.limits[r]}
            monthly
          />
        ))}
      </div>
    </div>
  )
}
