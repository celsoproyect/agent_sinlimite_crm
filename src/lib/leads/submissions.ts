// ============================================================
// Lead form submissions (migration 070). Shared by the public submit
// route, the Leads API and the Formularios tab.
// ============================================================

export interface LeadFormSubmission {
  id: string
  account_id: string
  contact_id: string | null
  deal_id: string | null
  name: string | null
  email: string | null
  phone: string | null
  message: string | null
  /** Every submitted field, exactly as received. */
  fields: Record<string, unknown>
  source_url: string | null
  user_agent: string | null
  ip: string | null
  is_read: boolean
  created_at: string
}

interface PgError {
  code?: string
  message?: string
}

/** The table (or a column) isn't there yet: migration 070 hasn't run.
 *  Postgres says 42P01; PostgREST says PGRST205/PGRST204 and "schema cache". */
export function isMissingTableError(err: unknown): boolean {
  const e = err as PgError | null
  if (!e) return false
  if (e.code === '42P01' || e.code === '42703' || e.code === 'PGRST205' || e.code === 'PGRST204') return true
  return /schema cache|does not exist/i.test(e.message ?? '')
}

const MAX_RAW_FIELDS = 60
const MAX_RAW_VALUE = 4000

/** A bounded copy of the request body, for `fields`. Strings are cut,
 *  nested values kept as JSON, and at most 60 keys survive. */
export function rawSubmissionFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(body).slice(0, MAX_RAW_FIELDS)) {
    const k = key.slice(0, 100)
    if (typeof value === 'string') out[k] = value.slice(0, MAX_RAW_VALUE)
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[k] = value
    else {
      try {
        const json = JSON.stringify(value)
        out[k] = json.length > MAX_RAW_VALUE ? json.slice(0, MAX_RAW_VALUE) : value
      } catch {
        // unserializable: skip
      }
    }
  }
  return out
}

/** Show a raw field value as text. */
export function fieldValueText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}
