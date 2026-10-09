import { describe, it, expect } from 'vitest'

import {
  activeExtras,
  effectiveLimits,
  extendPaidUntil,
  planModules,
  planState,
  remaining,
  usageAlertKey,
  usageLevel,
} from './limits'
import type { AccountExtra, PlanLimitsRow } from './types'

const NOW = new Date('2026-10-09T15:00:00Z')

const PLAN: PlanLimitsRow = {
  ai_replies_month: 1000,
  max_users: 3,
  max_contacts: null,
  broadcasts_month: 10,
  max_kb_documents: 20,
}

function extra(partial: Partial<AccountExtra>): AccountExtra {
  return {
    id: Math.random().toString(36).slice(2),
    resource: 'ai_replies',
    quantity: 0,
    module_key: null,
    expires_at: null,
    note: null,
    created_at: '2026-10-01T00:00:00Z',
    ...partial,
  }
}

describe('activeExtras', () => {
  it('keeps permanent and future extras, drops expired ones', () => {
    const live = extra({ expires_at: '2026-11-01T04:00:00Z' })
    const gone = extra({ expires_at: '2026-10-01T04:00:00Z' })
    const forever = extra({})
    expect(activeExtras([live, gone, forever], NOW)).toEqual([live, forever])
  })
})

describe('effectiveLimits', () => {
  it('has no limits without a plan', () => {
    const limits = effectiveLimits(null, [], null, NOW)
    expect(Object.values(limits).every((v) => v === null)).toBe(true)
  })

  it('keeps the per-account AI limit with no plan', () => {
    expect(effectiveLimits(null, [], 50, NOW).ai_replies).toBe(50)
  })

  it('adds active extras to the plan value', () => {
    const limits = effectiveLimits(
      PLAN,
      [
        extra({ resource: 'ai_replies', quantity: 500 }),
        extra({ resource: 'users', quantity: 2 }),
        extra({ resource: 'users', quantity: 1, expires_at: '2026-10-01T00:00:00Z' }),
      ],
      null,
      NOW,
    )
    expect(limits.ai_replies).toBe(1500)
    expect(limits.users).toBe(5)
    expect(limits.broadcasts).toBe(10)
  })

  it('leaves an unlimited plan resource unlimited even with extras', () => {
    expect(effectiveLimits(PLAN, [extra({ resource: 'contacts', quantity: 100 })], null, NOW).contacts).toBeNull()
  })

  it('lets the per-account AI limit replace the plan value', () => {
    expect(effectiveLimits(PLAN, [extra({ quantity: 100 })], 200, NOW).ai_replies).toBe(300)
  })
})

describe('planModules', () => {
  it('turns on module extras on top of the plan', () => {
    const out = planModules({ reports: false }, [extra({ resource: 'module', module_key: 'reports' })], NOW)
    expect(out.reports).toBe(true)
  })

  it('keeps plan-disabled modules off without an extra', () => {
    expect(planModules({ reports: false }, [], NOW).reports).toBe(false)
  })
})

describe('planState', () => {
  const day = 24 * 60 * 60 * 1000
  const at = (days: number) => new Date(NOW.getTime() + days * day).toISOString()

  it('is none without a plan', () => {
    expect(planState({ hasPlan: false, status: 'active', expiresAt: null }, NOW).state).toBe('none')
  })

  it('is suspended by hand regardless of dates', () => {
    expect(planState({ hasPlan: true, status: 'suspended', expiresAt: at(30) }, NOW).state).toBe(
      'suspended',
    )
  })

  it('is active with no date or a far date', () => {
    expect(planState({ hasPlan: true, status: 'active', expiresAt: null }, NOW).state).toBe('active')
    expect(planState({ hasPlan: true, status: 'active', expiresAt: at(20) }, NOW).state).toBe('active')
  })

  it('is expiring within the warning window', () => {
    const s = planState({ hasPlan: true, status: 'active', expiresAt: at(3) }, NOW)
    expect(s.state).toBe('expiring')
    expect(s.daysLeft).toBe(3)
  })

  it('stays trial until the trial date passes', () => {
    expect(planState({ hasPlan: true, status: 'trial', expiresAt: at(2) }, NOW).state).toBe('trial')
  })

  it('is past due during the grace days, then suspended', () => {
    expect(planState({ hasPlan: true, status: 'active', expiresAt: at(-2) }, NOW).state).toBe(
      'past_due',
    )
    expect(planState({ hasPlan: true, status: 'trial', expiresAt: at(-8) }, NOW).state).toBe(
      'suspended',
    )
  })
})

describe('usage helpers', () => {
  it('grades usage', () => {
    expect(usageLevel(5, null)).toBe('ok')
    expect(usageLevel(7, 10)).toBe('ok')
    expect(usageLevel(8, 10)).toBe('warn')
    expect(usageLevel(10, 10)).toBe('full')
  })

  it('computes what is left', () => {
    expect(remaining(3, 10)).toBe(7)
    expect(remaining(12, 10)).toBe(0)
    expect(remaining(3, null)).toBe(Infinity)
  })

  it('keys monthly alerts by month and the rest by limit', () => {
    expect(usageAlertKey('ai_replies', 80, 1000, '2026-10')).toBe('ai_replies:2026-10:80')
    expect(usageAlertKey('users', 100, 3, '2026-10')).toBe('users:3:100')
  })
})

describe('extendPaidUntil', () => {
  it('adds a period to a date still ahead', () => {
    expect(extendPaidUntil('2026-10-20T04:00:00.000Z', 'month', NOW)).toBe('2026-11-20T04:00:00.000Z')
  })

  it('counts from now once the date has passed', () => {
    expect(extendPaidUntil('2026-09-01T04:00:00.000Z', 'year', NOW)).toBe('2027-10-09T15:00:00.000Z')
  })

  it('counts from now with no date', () => {
    expect(extendPaidUntil(null, 'month', NOW)).toBe('2026-11-09T15:00:00.000Z')
  })
})
