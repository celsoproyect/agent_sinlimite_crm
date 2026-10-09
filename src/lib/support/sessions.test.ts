import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { loadOpenSupportSession, withoutSupportVisitors } from './sessions'

function dbReturning(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    is: () => Object.assign(Promise.resolve(result), { maybeSingle: () => Promise.resolve(result) }),
  }
  return chain as unknown as SupabaseClient
}

const ROWS = [{ user_id: 'owner' }, { user_id: 'agent' }, { user_id: 'super' }]

describe('withoutSupportVisitors', () => {
  it('drops users with an open support visit in the account', async () => {
    const db = dbReturning({ data: [{ user_id: 'super' }], error: null })
    expect(await withoutSupportVisitors(db, 'acct', ROWS)).toEqual([
      { user_id: 'owner' },
      { user_id: 'agent' },
    ])
  })

  it('keeps everyone before migration 073', async () => {
    const db = dbReturning({ data: null, error: { code: 'PGRST205', message: 'missing' } })
    expect(await withoutSupportVisitors(db, 'acct', ROWS)).toEqual(ROWS)
  })

  it('keeps everyone when the lookup fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = dbReturning({ data: null, error: { code: '500', message: 'boom' } })
    expect(await withoutSupportVisitors(db, 'acct', ROWS)).toEqual(ROWS)
  })
})

describe('loadOpenSupportSession', () => {
  it('is null before migration 073', async () => {
    const db = dbReturning({ data: null, error: { code: '42P01', message: 'missing' } })
    expect(await loadOpenSupportSession(db, 'super')).toBeNull()
  })

  it('returns the open visit', async () => {
    const row = { id: 's1', user_id: 'super', account_id: 'client', home_account_id: 'home', home_role: 'owner', started_at: 'x' }
    expect(await loadOpenSupportSession(dbReturning({ data: row, error: null }), 'super')).toEqual(row)
  })
})
