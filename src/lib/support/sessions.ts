import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountRole } from '@/lib/auth/roles'

// ============================================================
// Support mode (migration 073).
//
// The super admin "enters" a client's account by moving their own
// profile into it as an admin; `support_sessions` remembers the home
// account to return to and doubles as the audit log. These helpers
// take the service-role client — the table has no RLS policies.
// ============================================================

export interface SupportSession {
  id: string
  user_id: string
  account_id: string
  home_account_id: string
  home_role: AccountRole
  started_at: string
}

/** The role the super admin gets inside a client's account. */
export const SUPPORT_ROLE: AccountRole = 'admin'

/** Postgres/PostgREST codes for "the table isn't there yet". */
export function isMissingTable(code: string | undefined): boolean {
  return code === '42P01' || code === 'PGRST205'
}

/** The super admin's open visit, or null (also before migration 073). */
export async function loadOpenSupportSession(
  admin: SupabaseClient,
  userId: string,
): Promise<SupportSession | null> {
  const { data, error } = await admin
    .from('support_sessions')
    .select('id, user_id, account_id, home_account_id, home_role, started_at')
    .eq('user_id', userId)
    .is('ended_at', null)
    .maybeSingle()
  if (error) {
    if (!isMissingTable(error.code)) {
      console.error('[support] session load failed:', error.message)
    }
    return null
  }
  return (data as SupportSession | null) ?? null
}

/**
 * Users currently visiting this account in support mode. They are
 * members as far as RLS is concerned, but the client should never see
 * them in their team, pickers or alerts. Best-effort: empty on error.
 */
export async function supportVisitorIds(
  admin: SupabaseClient,
  accountId: string,
): Promise<Set<string>> {
  const { data, error } = await admin
    .from('support_sessions')
    .select('user_id')
    .eq('account_id', accountId)
    .is('ended_at', null)
  if (error) {
    if (!isMissingTable(error.code)) {
      console.error('[support] visitor lookup failed:', error.message)
    }
    return new Set()
  }
  return new Set(((data as { user_id: string }[] | null) ?? []).map((r) => r.user_id))
}

/** Drop support visitors from a list of profile rows. */
export async function withoutSupportVisitors<T extends { user_id: string }>(
  admin: SupabaseClient,
  accountId: string,
  rows: T[],
): Promise<T[]> {
  if (rows.length === 0) return rows
  const visitors = await supportVisitorIds(admin, accountId)
  return visitors.size === 0 ? rows : rows.filter((r) => !visitors.has(r.user_id))
}
