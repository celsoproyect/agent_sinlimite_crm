// Validation for the events module's CRUD routes (/api/events/*). Pure,
// so the rules are unit-tested without a database.

export const MAX_NAME_LENGTH = 120
export const MAX_DESCRIPTION_LENGTH = 1000

type Parsed<T> = { input: T } | { error: string }

export interface HallInput {
  name?: string
  description?: string | null
  capacity_min?: number
  capacity_max?: number
  price_per_hour?: number | null
  min_hours?: number
  setup_minutes?: number
  cleanup_minutes?: number
  /** null = the account's setting. */
  requires_approval?: boolean | null
  /** null = the account's setting, 0 = no deposit for this hall. */
  deposit_percent?: number | null
  active?: boolean
  sort_order?: number
}

export interface PackageInput {
  hall_id?: string | null
  name?: string
  description?: string | null
  price?: number | null
  price_per_person?: number | null
  min_guests?: number | null
  max_guests?: number | null
  duration_hours?: number | null
  active?: boolean
  sort_order?: number
}

/** A number from a form field: '' / null = null, else finite or undefined (invalid). */
function optionalNumber(value: unknown): number | null | undefined {
  if (value === null || value === '') return null
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : undefined
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

/** Create (`partial` false: name and capacity required) or update. */
export function parseHallInput(body: unknown, partial: boolean): Parsed<HallInput> {
  if (!body || typeof body !== 'object') return { error: 'invalid_body' }
  const b = body as Record<string, unknown>
  const input: HallInput = {}

  if ('name' in b || !partial) {
    const name = text(b.name, MAX_NAME_LENGTH)
    if (!name) return { error: 'name_required' }
    input.name = name
  }
  if ('description' in b) input.description = text(b.description, MAX_DESCRIPTION_LENGTH)

  for (const key of ['capacity_min', 'capacity_max', 'setup_minutes', 'cleanup_minutes', 'sort_order'] as const) {
    if (!(key in b)) continue
    const n = optionalNumber(b[key])
    const min = key.startsWith('capacity') ? 1 : key === 'sort_order' ? -10000 : 0
    if (n == null || n < min) return { error: `invalid_${key}` }
    input[key] = Math.round(n)
  }
  if (!partial && input.capacity_max === undefined) return { error: 'invalid_capacity_max' }
  if (!partial && input.capacity_min === undefined) input.capacity_min = 1
  if (input.capacity_min !== undefined && input.capacity_max !== undefined && input.capacity_max < input.capacity_min) {
    return { error: 'invalid_capacity' }
  }

  if ('price_per_hour' in b) {
    const n = optionalNumber(b.price_per_hour)
    if (n === undefined || (n !== null && n < 0)) return { error: 'invalid_price' }
    input.price_per_hour = n
  }
  if ('min_hours' in b) {
    const n = optionalNumber(b.min_hours)
    if (n == null || n <= 0 || n > 24) return { error: 'invalid_min_hours' }
    input.min_hours = Math.round(n * 100) / 100
  }
  if ('requires_approval' in b) {
    if (b.requires_approval !== null && typeof b.requires_approval !== 'boolean') return { error: 'invalid_approval' }
    input.requires_approval = b.requires_approval as boolean | null
  }
  if ('deposit_percent' in b) {
    const n = optionalNumber(b.deposit_percent)
    if (n === undefined || (n !== null && (n < 0 || n > 100))) return { error: 'invalid_deposit_percent' }
    input.deposit_percent = n === null ? null : Math.round(n * 100) / 100
  }
  if ('active' in b) {
    if (typeof b.active !== 'boolean') return { error: 'invalid_active' }
    input.active = b.active
  }
  return { input }
}

/** Create (`partial` false: name required) or update. */
export function parsePackageInput(body: unknown, partial: boolean): Parsed<PackageInput> {
  if (!body || typeof body !== 'object') return { error: 'invalid_body' }
  const b = body as Record<string, unknown>
  const input: PackageInput = {}

  if ('name' in b || !partial) {
    const name = text(b.name, MAX_NAME_LENGTH)
    if (!name) return { error: 'name_required' }
    input.name = name
  }
  if ('description' in b) input.description = text(b.description, MAX_DESCRIPTION_LENGTH)
  if ('hall_id' in b) {
    if (b.hall_id !== null && b.hall_id !== '' && typeof b.hall_id !== 'string') return { error: 'invalid_hall' }
    input.hall_id = typeof b.hall_id === 'string' && b.hall_id ? b.hall_id : null
  }
  for (const key of ['price', 'price_per_person'] as const) {
    if (!(key in b)) continue
    const n = optionalNumber(b[key])
    if (n === undefined || (n !== null && n < 0)) return { error: 'invalid_price' }
    input[key] = n
  }
  for (const key of ['min_guests', 'max_guests'] as const) {
    if (!(key in b)) continue
    const n = optionalNumber(b[key])
    if (n === undefined || (n !== null && n < 1)) return { error: 'invalid_guests' }
    input[key] = n === null ? null : Math.round(n)
  }
  if (input.min_guests != null && input.max_guests != null && input.max_guests < input.min_guests) {
    return { error: 'invalid_guests' }
  }
  if ('duration_hours' in b) {
    const n = optionalNumber(b.duration_hours)
    if (n === undefined || (n !== null && (n <= 0 || n > 24))) return { error: 'invalid_duration' }
    input.duration_hours = n
  }
  if ('sort_order' in b) {
    const n = optionalNumber(b.sort_order)
    if (n == null) return { error: 'invalid_sort_order' }
    input.sort_order = Math.round(n)
  }
  if ('active' in b) {
    if (typeof b.active !== 'boolean') return { error: 'invalid_active' }
    input.active = b.active
  }
  return { input }
}

/** The deposit for a quote under the hall's policy, or null without one. */
export function depositFor(quote: number | null, policy: { depositRequired: boolean; depositPercent: number }): number | null {
  if (quote == null || !policy.depositRequired) return null
  return Math.round(quote * policy.depositPercent) / 100
}
