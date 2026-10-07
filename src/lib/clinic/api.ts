import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import type { Professional } from '@/types'

// Shared plumbing for the clinic module's routes (/api/clinic/*).

/** Postgres/PostgREST codes for "migration 066 hasn't run yet". */
export function isMissingClinicSchema(code: string | undefined): boolean {
  return code === '42P01' || code === '42703' || code === 'PGRST200' || code === 'PGRST205'
}

/** A Supabase error as the route's JSON response. */
export function clinicDbError(error: { code?: string; message: string }) {
  if (isMissingClinicSchema(error.code)) {
    return NextResponse.json({ error: 'clinic_not_migrated' }, { status: 503 })
  }
  if (error.code === '23505') return NextResponse.json({ error: 'duplicate_name' }, { status: 409 })
  return NextResponse.json({ error: error.message }, { status: 500 })
}

/** Admin + the clinic module on, or the error response to return. */
export async function clinicAdmin(): Promise<{ ctx: AccountContext } | { response: Response }> {
  let ctx: AccountContext
  try {
    ctx = await requireRole('admin')
  } catch (err) {
    return { response: toErrorResponse(err) }
  }
  if (!(await accountModuleEnabled(ctx.supabase, ctx.accountId, 'clinic'))) {
    return { response: NextResponse.json({ error: 'module_disabled' }, { status: 403 }) }
  }
  return { ctx }
}

export const PROFESSIONAL_SELECT =
  // `*` so is_sample (migration 068) comes along once it exists.
  '*, professional_specialties(specialty_id)'

type ProfessionalRow = Omit<Professional, 'specialty_ids'> & {
  professional_specialties?: { specialty_id: string }[] | null
}

/** A professionals row (with its join rows) as the API's `Professional`. */
export function toProfessional(row: ProfessionalRow): Professional {
  const { professional_specialties, ...rest } = row
  return { ...rest, specialty_ids: (professional_specialties ?? []).map((ps) => ps.specialty_id) }
}

/** Replace a doctor's specialties with `specialtyIds`. Returns an error
 *  message, or null on success. */
export async function replaceProfessionalSpecialties(
  db: SupabaseClient,
  professionalId: string,
  specialtyIds: string[],
): Promise<string | null> {
  const { error: delError } = await db.from('professional_specialties').delete().eq('professional_id', professionalId)
  if (delError) return delError.message
  if (specialtyIds.length === 0) return null
  const { data, error } = await db
    .from('professional_specialties')
    .insert(specialtyIds.map((specialty_id) => ({ professional_id: professionalId, specialty_id })))
    .select('specialty_id')
  if (error) return error.message
  if ((data ?? []).length !== specialtyIds.length) return 'specialties_not_saved'
  return null
}

/** Load one doctor in API shape. */
export async function loadProfessional(db: SupabaseClient, accountId: string, id: string) {
  const { data, error } = await db
    .from('professionals')
    .select(PROFESSIONAL_SELECT)
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data) return null
  return toProfessional(data as unknown as ProfessionalRow)
}

export type { ProfessionalRow }
