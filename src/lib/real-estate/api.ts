import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account'
import type { AccountRole } from '@/lib/auth/roles'
import { accountModuleEnabled } from '@/lib/modules-server'
import { canonicalAmenities } from './amenities'
import { isMissingPropertiesSchema } from './directory'
import { PROPERTY_OPERATIONS, PROPERTY_STATUSES, PROPERTY_TYPES } from './search'

// Shared plumbing for the real estate module's routes (/api/properties/*).

/** A Supabase error as the route's JSON response. */
export function propertiesDbError(error: { code?: string; message: string }) {
  if (isMissingPropertiesSchema(error.code)) {
    return NextResponse.json({ error: 'needs_migration' }, { status: 503 })
  }
  if (error.code === '23505') return NextResponse.json({ error: 'duplicate_code' }, { status: 409 })
  if (error.code === '23514') return NextResponse.json({ error: 'invalid_values' }, { status: 400 })
  if (error.code === '23503') return NextResponse.json({ error: 'invalid_advisor' }, { status: 400 })
  return NextResponse.json({ error: error.message }, { status: 500 })
}

/** The role + the properties module on, or the error response to return. */
export async function propertiesGuard(role: AccountRole): Promise<{ ctx: AccountContext } | { response: Response }> {
  let ctx: AccountContext
  try {
    ctx = await requireRole(role)
  } catch (err) {
    return { response: toErrorResponse(err) }
  }
  if (!(await accountModuleEnabled(ctx.supabase, ctx.accountId, 'properties'))) {
    return { response: NextResponse.json({ error: 'module_disabled' }, { status: 403 }) }
  }
  return { ctx }
}

function str(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

/** A non-negative number up to `max`, null when blank, NaN when invalid. */
function numOrNull(value: unknown, max: number, integer = false): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/,/g, '')) : NaN
  if (!Number.isFinite(n) || n < 0 || n > max) return NaN
  return integer ? Math.round(n) : n
}

const NUMBER_FIELDS: [key: string, max: number, integer: boolean][] = [
  ['price', 999_999_999_999, false],
  ['bedrooms', 50, true],
  ['bathrooms', 50, false],
  ['parking', 50, true],
  ['area_m2', 99_999_999, false],
]

/** Property fields from a request body. `partial` = PATCH (only what was sent). Pure. */
export function parsePropertyInput(
  raw: unknown,
  partial: boolean,
): { input: Record<string, unknown> } | { error: string } {
  const b = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null
  if (!b) return { error: 'invalid_json' }
  const input: Record<string, unknown> = {}
  if ('title' in b || !partial) {
    const title = str(b.title, 160)
    if (!title) return { error: 'title_required' }
    input.title = title
  }
  if ('code' in b) input.code = str(b.code, 40)
  if ('operation' in b || !partial) {
    const op = 'operation' in b ? b.operation : 'sale'
    if (!(PROPERTY_OPERATIONS as readonly unknown[]).includes(op)) return { error: 'invalid_operation' }
    input.operation = op
  }
  if ('property_type' in b || !partial) {
    const t = 'property_type' in b ? b.property_type : 'apartment'
    if (!(PROPERTY_TYPES as readonly unknown[]).includes(t)) return { error: 'invalid_type' }
    input.property_type = t
  }
  if ('status' in b) {
    if (!(PROPERTY_STATUSES as readonly unknown[]).includes(b.status)) return { error: 'invalid_status' }
    input.status = b.status
  }
  for (const key of ['zone', 'city', 'address'] as const) {
    if (key in b) input[key] = str(b[key], 160)
  }
  if ('description' in b) input.description = str(b.description, 4000)
  if ('currency' in b) input.currency = (str(b.currency, 3) ?? 'USD').toUpperCase()
  for (const [key, max, integer] of NUMBER_FIELDS) {
    if (!(key in b)) continue
    const n = numOrNull(b[key], max, integer)
    if (Number.isNaN(n) || (key === 'area_m2' && n === 0)) return { error: `invalid_${key}` }
    // Bathrooms go in halves (2.5 = two full and a half bath).
    input[key] = key === 'bathrooms' && n != null ? Math.round(n * 2) / 2 : n
  }
  if ('amenities' in b) input.amenities = canonicalAmenities(b.amenities)
  if ('photos' in b) {
    const photos = Array.isArray(b.photos) ? b.photos : []
    input.photos = photos.filter((p): p is string => typeof p === 'string' && /^https?:\/\//.test(p)).slice(0, 20)
  }
  if ('advisor_id' in b) input.advisor_id = typeof b.advisor_id === 'string' && b.advisor_id ? b.advisor_id : null
  if ('active' in b) input.active = b.active !== false
  if ('sort_order' in b) {
    const n = numOrNull(b.sort_order, 10000, true)
    input.sort_order = n == null || Number.isNaN(n) ? 0 : n
  }
  return { input }
}
