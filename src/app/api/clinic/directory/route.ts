import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { accountModuleEnabled } from '@/lib/modules-server'
import { businessToday } from '@/lib/business-timezone'
import { normalizeClinicSettings } from '@/lib/clinic/directory'
import {
  PROFESSIONAL_SELECT,
  isMissingClinicSchema,
  toProfessional,
  type ProfessionalRow,
} from '@/lib/clinic/api'

// Clinic module: every doctor (active or not) and specialty of the
// account, for the Agenda's doctors dialog, booking form and filters.
// `enabled` false = module off; `migrated` false = migration 066 pending;
// `extended` false = migration 067 pending (services, time off, insurance).

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    if (!(await accountModuleEnabled(supabase, accountId, 'clinic'))) {
      return NextResponse.json({ enabled: false, migrated: false, extended: false, ...EMPTY })
    }
    const [professionalsRes, specialtiesRes, servicesRes, timeOffRes, settingsRes] = await Promise.all([
      supabase
        .from('professionals')
        .select(PROFESSIONAL_SELECT)
        .eq('account_id', accountId)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }),
      supabase
        .from('specialties')
        .select('*')
        .eq('account_id', accountId)
        .order('name', { ascending: true }),
      supabase
        .from('clinic_services')
        .select('*')
        .eq('account_id', accountId)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }),
      supabase
        .from('professional_time_off')
        .select('*')
        .eq('account_id', accountId)
        .gte('ends_on', businessToday())
        .order('starts_on', { ascending: true }),
      supabase.from('accounts').select('clinic_settings').eq('id', accountId).maybeSingle(),
    ])
    const error = professionalsRes.error ?? specialtiesRes.error
    if (error) {
      if (isMissingClinicSchema(error.code)) {
        return NextResponse.json({ enabled: true, migrated: false, extended: false, ...EMPTY })
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({
      enabled: true,
      migrated: true,
      professionals: ((professionalsRes.data ?? []) as unknown as ProfessionalRow[]).map(toProfessional),
      specialties: specialtiesRes.data ?? [],
      ...extendedPart(servicesRes, timeOffRes, settingsRes),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

const EMPTY = {
  professionals: [],
  specialties: [],
  services: [],
  time_off: [],
  settings: { ask_insurance: false, insurers: [] },
}

type Res = { data: unknown; error: { code?: string; message: string } | null }

/** Migration 067's part: empty with `extended: false` until it has run. */
function extendedPart(services: Res, timeOff: Res, settings: Res) {
  const error = services.error ?? timeOff.error ?? settings.error
  if (error && isMissingClinicSchema(error.code)) {
    return { extended: false, services: [], time_off: [], settings: EMPTY.settings }
  }
  const raw = (settings.data as { clinic_settings?: unknown } | null)?.clinic_settings
  const normalized = normalizeClinicSettings(raw)
  return {
    extended: !error,
    services: services.data ?? [],
    time_off: timeOff.data ?? [],
    settings: { ask_insurance: normalized.ask, insurers: normalized.insurers },
  }
}
