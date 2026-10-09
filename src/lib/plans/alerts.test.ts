import { describe, it, expect, vi } from 'vitest'

vi.mock('./server', () => ({
  isMissingSchema: () => false,
  loadPlanSnapshot: vi.fn(),
  loadUsage: vi.fn(),
}))
vi.mock('@/lib/support/sessions', () => ({ withoutSupportVisitors: vi.fn() }))

import { dueAlerts } from './alerts'
import { planState } from './limits'
import type { PlanSnapshot } from './server'
import type { Plan, Usage } from './types'

const NOW = new Date('2026-10-09T15:00:00Z')

const PLAN: Plan = {
  id: 'p1',
  name: 'Pro',
  description: null,
  price: 30,
  currency: 'USD',
  billing_interval: 'month',
  modules: {},
  is_active: true,
  sort_order: 0,
  ai_replies_month: 100,
  max_users: 3,
  max_contacts: null,
  broadcasts_month: 10,
  max_kb_documents: 20,
}

function snapshot(expiresAt: string | null, status: 'active' | 'trial' | 'suspended' = 'active'): PlanSnapshot {
  return {
    accountId: 'a1',
    accountName: 'Clínica Sol',
    plan: PLAN,
    status,
    expiresAt,
    aiMonthlyLimit: null,
    extras: [],
    limits: { ai_replies: 100, users: 3, contacts: null, broadcasts: 10, kb_documents: 20 },
    state: planState({ hasPlan: true, status, expiresAt }, NOW),
    migrated: true,
  }
}

const USAGE: Usage = { ai_replies: 85, users: 3, contacts: 9999, broadcasts: 1, kb_documents: 0 }

describe('dueAlerts', () => {
  it('flags 80% and 100% of limits, skipping unlimited ones', () => {
    const keys = dueAlerts(snapshot(null), USAGE, NOW).map((a) => a.key)
    expect(keys).toEqual(['ai_replies:2026-10:80', 'users:3:100'])
  })

  it('names the account for the super admin', () => {
    const [alert] = dueAlerts(snapshot(null), USAGE, NOW)
    expect(alert.adminTitle).toContain('Clínica Sol')
    expect(alert.title).not.toContain('Clínica Sol')
  })

  it('warns before expiry, keyed by the date', () => {
    const alerts = dueAlerts(snapshot('2026-10-12T04:00:00.000Z'), { ...USAGE, ai_replies: 0, users: 0 }, NOW)
    expect(alerts.map((a) => a.key)).toEqual(['expiring:2026-10-12'])
    expect(alerts[0].body).toContain('11/10/2026')
  })

  it('reports past due and suspended accounts', () => {
    const quiet = { ...USAGE, ai_replies: 0, users: 0 }
    expect(dueAlerts(snapshot('2026-10-05T04:00:00.000Z'), quiet, NOW)[0].key).toBe('past_due:2026-10-05')
    expect(dueAlerts(snapshot(null, 'suspended'), quiet, NOW)[0].key).toBe('suspended:none')
  })

  it('sends nothing without a plan', () => {
    expect(dueAlerts({ ...snapshot(null), plan: null }, USAGE, NOW)).toEqual([])
  })
})
