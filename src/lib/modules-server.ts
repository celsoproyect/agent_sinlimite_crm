import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_OFF_MODULES, isModuleEnabled, type EnabledModules, type ModuleKey } from './modules'

/**
 * Server-side module check for routes and background jobs, so a module
 * the super admin switched off stops working, not just its menu entry.
 * Fails open (enabled) when the row can't be read, like the client —
 * except for the modules that start off, which fail closed.
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
    if (error || !data) return !DEFAULT_OFF_MODULES.has(key)
    return isModuleEnabled(data.enabled_modules as EnabledModules | null, key)
  } catch {
    return !DEFAULT_OFF_MODULES.has(key)
  }
}
