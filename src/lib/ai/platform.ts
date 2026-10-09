import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { businessLocalToInstant, businessToday } from '@/lib/business-timezone'
import type { AiProvider } from './types'
import { EMBEDDING_MODEL } from './embeddings'

// ============================================================
// Platform AI key (migration 072).
//
// The super admin pays for the AI and bills it inside the plan, so every
// account without its own key runs on this single platform config. The
// row lives in `platform_ai_config` (RLS on, no policies) and is read
// here with the service role only — it never reaches a client.
//
// `accounts.ai_monthly_limit` caps the AI replies an account can spend
// on the platform key per business month (NULL = no limit). Accounts on
// their own key are never capped: they pay their provider directly.
// ============================================================

export interface PlatformAiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  embeddingsApiKey: string | null
  embeddingsModel: string
}

interface PlatformRow {
  provider: AiProvider
  model: string
  api_key: string
  embeddings_api_key: string | null
  embeddings_model: string | null
}

const CACHE_MS = 30_000
let cache: { at: number; value: PlatformAiConfig | null } | null = null

/** Drop the cached platform config (after the super admin saves it). */
export function clearPlatformAiCache(): void {
  cache = null
}

/** Postgres/PostgREST codes for "the table isn't there yet". */
function isMissingTable(code: string | undefined): boolean {
  return code === '42P01' || code === 'PGRST205'
}

/**
 * Raw platform row, still encrypted. Null when nothing is saved or
 * migration 072 hasn't run.
 */
export async function loadPlatformAiRow(): Promise<PlatformRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('platform_ai_config')
    .select('provider, model, api_key, embeddings_api_key, embeddings_model')
    .eq('id', true)
    .maybeSingle()
  if (error) {
    if (!isMissingTable(error.code)) {
      console.error('[ai platform] load failed:', error.message)
    }
    return null
  }
  return (data as PlatformRow | null) ?? null
}

/**
 * The decrypted platform config, cached for 30s per server process.
 * Never throws: a missing table, a missing row or an undecryptable key
 * all mean "no platform AI", and callers treat that as "not configured".
 */
export async function loadPlatformAiConfig(): Promise<PlatformAiConfig | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  let value: PlatformAiConfig | null = null
  try {
    const row = await loadPlatformAiRow()
    if (row?.api_key) {
      let embeddingsApiKey: string | null = null
      if (row.embeddings_api_key) {
        try {
          embeddingsApiKey = decrypt(row.embeddings_api_key)
        } catch {
          console.error(
            '[ai platform] embeddings key could not be decrypted — check ENCRYPTION_KEY.',
          )
        }
      }
      value = {
        provider: row.provider,
        model: row.model,
        apiKey: decrypt(row.api_key),
        embeddingsApiKey,
        embeddingsModel: row.embeddings_model || EMBEDDING_MODEL,
      }
    }
  } catch (err) {
    console.error(
      '[ai platform] key could not be decrypted — check ENCRYPTION_KEY:',
      err instanceof Error ? err.message : err,
    )
    value = null
  }
  cache = { at: Date.now(), value }
  return value
}

/** First instant of the current business month (Santo Domingo). */
export function businessMonthStart(now: Date = new Date()): Date {
  const today = businessToday(now)
  return businessLocalToInstant(`${today.slice(0, 7)}-01`, '00:00')
}

/** The account's monthly AI cap; null = no limit (or column missing). */
export async function loadAiMonthlyLimit(
  db: SupabaseClient,
  accountId: string,
): Promise<number | null> {
  const { data, error } = await db
    .from('accounts')
    .select('ai_monthly_limit')
    .eq('id', accountId)
    .maybeSingle()
  if (error) {
    if (error.code !== '42703') {
      console.error('[ai platform] limit load failed:', error.message)
    }
    return null
  }
  const limit = (data as { ai_monthly_limit?: number | null } | null)?.ai_monthly_limit
  return typeof limit === 'number' ? limit : null
}

/** AI replies (logged LLM runs) the account spent this business month. */
export async function countAiRunsThisMonth(
  db: SupabaseClient,
  accountId: string,
  now: Date = new Date(),
): Promise<number> {
  const { count, error } = await db
    .from('ai_usage_log')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .gte('created_at', businessMonthStart(now).toISOString())
  if (error) {
    console.error('[ai platform] usage count failed:', error.message)
    return 0
  }
  return count ?? 0
}

export interface AiQuota {
  limit: number | null
  used: number
  exceeded: boolean
}

/**
 * Monthly quota for an account on the platform key. Reads with the
 * service role, so it works from any route regardless of the caller's
 * RLS (usage rows are admin-only).
 */
export async function loadAiQuota(accountId: string): Promise<AiQuota> {
  const admin = supabaseAdmin()
  const limit = await loadAiMonthlyLimit(admin, accountId)
  if (limit === null) return { limit: null, used: 0, exceeded: false }
  const used = await countAiRunsThisMonth(admin, accountId)
  return { limit, used, exceeded: used >= limit }
}
