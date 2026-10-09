// Turns a plan refusal (409 plan_limit / plan_suspended from the API, or
// the contacts trigger's 'plan_limit:contacts' error) into the Plan.errors
// message key and its values. Pure, so the browser and tests share it.

import { isPlanResource, type PlanResource } from './types'

export type PlanErrorMessage =
  | { key: 'suspended' }
  | { key: 'limitReached'; resource: PlanResource; used: number | null; limit: number | null }

export function planErrorFromBody(body: unknown): PlanErrorMessage | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (b.code === 'plan_suspended') return { key: 'suspended' }
  if (b.code === 'plan_limit' && isPlanResource(b.resource)) {
    return {
      key: 'limitReached',
      resource: b.resource,
      used: typeof b.used === 'number' ? b.used : null,
      limit: typeof b.limit === 'number' ? b.limit : null,
    }
  }
  return null
}

/** The contacts trigger raises 'plan_limit:contacts' with DETAIL "used/limit". */
export function planErrorFromDb(
  error: { message?: string | null; details?: string | null } | null | undefined,
): PlanErrorMessage | null {
  if (!error?.message?.includes('plan_limit:contacts')) return null
  const m = /^(\d+)\/(\d+)$/.exec(error.details ?? '')
  return {
    key: 'limitReached',
    resource: 'contacts',
    used: m ? Number(m[1]) : null,
    limit: m ? Number(m[2]) : null,
  }
}
