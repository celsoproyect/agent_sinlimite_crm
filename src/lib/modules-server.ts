import type { SupabaseClient } from '@supabase/supabase-js'
import { isModuleEnabled, type EnabledModules, type ModuleKey } from './modules'

/**
 * Server-side module check for routes and background jobs, so a module
 * the super admin switched off stops working, not just its menu entry.
 * Fails open (enabled) when the row can't be read, like the client.
 */
export async function accountModuleEnabled(
  db: SupabaseClient,
  accountId: string,
  key: ModuleKey,
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from('accounts')
      .select('enabled_modules')
      .eq('id', accountId)
      .maybeSingle()
    if (error || !data) return true
    return isModuleEnabled(data.enabled_modules as EnabledModules | null, key)
  } catch {
    return true
  }
}
