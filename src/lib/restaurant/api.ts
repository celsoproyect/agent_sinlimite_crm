import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account'
import type { AccountRole } from '@/lib/auth/roles'
import { accountModuleEnabled } from '@/lib/modules-server'
import type { ModuleKey } from '@/lib/modules'
import { isMissingRestaurantSchema } from './engine'

// Shared plumbing for the restaurant module's routes (/api/restaurant/*).

/** A Supabase error as the route's JSON response. */
export function restaurantDbError(error: { code?: string; message: string }) {
  if (isMissingRestaurantSchema(error.code)) {
    return NextResponse.json({ error: 'needs_migration' }, { status: 503 })
  }
  if (error.code === '23505') return NextResponse.json({ error: 'duplicate_name' }, { status: 409 })
  if (error.code === '23P01') return NextResponse.json({ error: 'table_busy' }, { status: 409 })
  if (error.code === '23514') return NextResponse.json({ error: 'invalid_values' }, { status: 400 })
  return NextResponse.json({ error: error.message }, { status: 500 })
}

/** The role + the restaurant module on (and `waitlist` when asked), or
 *  the error response to return. */
export async function restaurantGuard(
  role: AccountRole,
  opts: { waitlist?: boolean } = {},
): Promise<{ ctx: AccountContext } | { response: Response }> {
  let ctx: AccountContext
  try {
    ctx = await requireRole(role)
  } catch (err) {
    return { response: toErrorResponse(err) }
  }
  const modules: ModuleKey[] = opts.waitlist ? ['restaurant', 'waitlist'] : ['restaurant']
  for (const m of modules) {
    if (!(await accountModuleEnabled(ctx.supabase, ctx.accountId, m))) {
      return { response: NextResponse.json({ error: 'module_disabled' }, { status: 403 }) }
    }
  }
  return { ctx }
}

export function str(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

export function intIn(value: unknown, min: number, max: number): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n)) return null
  const r = Math.round(n)
  return r >= min && r <= max ? r : null
}

/** Area fields from a request body. `partial` = PATCH (only what was sent). */
export function parseAreaInput(
  raw: unknown,
  partial: boolean,
): { input: Record<string, unknown> } | { error: string } {
  const b = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null
  if (!b) return { error: 'invalid_json' }
  const input: Record<string, unknown> = {}
  if ('name' in b || !partial) {
    const name = str(b.name, 80)
    if (!name) return { error: 'name_required' }
    input.name = name
  }
  if ('description' in b) input.description = str(b.description, 500)
  if ('active' in b) input.active = b.active !== false
  if ('sort_order' in b) input.sort_order = intIn(b.sort_order, -10000, 10000) ?? 0
  return { input }
}

/** Table fields from a request body. */
export function parseTableInput(
  raw: unknown,
  partial: boolean,
): { input: Record<string, unknown> } | { error: string } {
  const b = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null
  if (!b) return { error: 'invalid_json' }
  const input: Record<string, unknown> = {}
  if ('name' in b || !partial) {
    const name = str(b.name, 80)
    if (!name) return { error: 'name_required' }
    input.name = name
  }
  if ('area_id' in b) input.area_id = typeof b.area_id === 'string' && b.area_id ? b.area_id : null
  if ('min_party' in b || !partial) {
    const min = 'min_party' in b ? intIn(b.min_party, 1, 500) : 1
    if (min == null) return { error: 'invalid_party' }
    input.min_party = min
  }
  if ('max_party' in b || !partial) {
    const max = intIn(b.max_party, 1, 500)
    if (max == null) return { error: 'invalid_party' }
    input.max_party = max
  }
  if (typeof input.min_party === 'number' && typeof input.max_party === 'number' && input.max_party < input.min_party) {
    return { error: 'invalid_party' }
  }
  if ('combinable' in b) input.combinable = b.combinable !== false
  if ('active' in b) input.active = b.active !== false
  if ('sort_order' in b) input.sort_order = intIn(b.sort_order, -10000, 10000) ?? 0
  if ('notes' in b) input.notes = str(b.notes, 500)
  return { input }
}
