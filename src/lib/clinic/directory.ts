import type { SupabaseClient } from '@supabase/supabase-js'
import type { BookingSettings } from '@/types'
import { accountModuleEnabled } from '@/lib/modules-server'
import { businessToday } from '@/lib/business-timezone'

// ============================================================
// Clinic module (migration 066): doctors ("professionals") with
// specialties, each with their own agenda. When the account has the
// `clinic` module on and at least one active doctor, the booking engine
// (lib/ai/booking.ts) schedules per doctor instead of on one shared
// agenda, and the AI gets the doctor roster plus `find_professionals`.
// ============================================================

export type WeeklyHours = NonNullable<BookingSettings['hours']>

export interface ClinicProfessional {
  id: string
  name: string
  bio: string | null
  /** Own weekly hours; null = the business hours. */
  hours: WeeklyHours | null
  /** Own appointment length; null = the business slot length. */
  slotMinutes: number | null
  specialties: string[]
  /** Upcoming days off (migration 067), business-local and inclusive. */
  timeOff?: { from: string; to: string }[]
}

/** A kind of appointment with its own length (migration 067). */
export interface ClinicService {
  id: string
  name: string
  description: string | null
  /** Only doctors of this specialty offer it; null = any doctor. */
  specialty: string | null
  durationMinutes: number
  price: number | null
}

/** `accounts.clinic_settings` (migration 067). */
export interface ClinicInsurance {
  /** The agent asks for the health insurance (ARS) before booking. */
  ask: boolean
  /** Insurers the clinic accepts. Empty = any. */
  insurers: string[]
}

export interface ClinicDirectory {
  professionals: ClinicProfessional[]
  specialties: string[]
  services?: ClinicService[]
  insurance?: ClinicInsurance
}

interface ProfessionalRow {
  id: string
  name: string
  bio: string | null
  active: boolean
  hours: WeeklyHours | null
  slot_minutes: number | null
  sort_order: number | null
  professional_specialties?: { specialty: { name: string } | null }[] | null
}

interface TimeOffRow {
  professional_id: string
  starts_on: string
  ends_on: string
}

interface ServiceRow {
  id: string
  name: string
  description: string | null
  duration_minutes: number
  price: number | string | null
  specialty?: { name: string } | null
}

/** `accounts.clinic_settings` as stored, normalized. */
export function normalizeClinicSettings(raw: unknown): ClinicInsurance {
  const value = (raw && typeof raw === 'object' ? raw : {}) as { ask_insurance?: unknown; insurers?: unknown }
  const insurers = Array.isArray(value.insurers)
    ? [...new Set(value.insurers.filter((i): i is string => typeof i === 'string').map((i) => i.trim()).filter(Boolean))]
    : []
  return { ask: value.ask_insurance === true, insurers }
}

/** True for "table/column doesn't exist yet" (migration 066 not run). */
function missingSchema(code: string | undefined): boolean {
  return code === '42P01' || code === '42703' || code === 'PGRST200' || code === 'PGRST205'
}

function hasOpenDay(hours: WeeklyHours | null | undefined): boolean {
  return !!hours && Object.values(hours).some((h) => !!h)
}

/**
 * The account's active doctors with their specialties, or null when the
 * clinic module is off, migration 066 hasn't run, or there are no active
 * doctors — in which case booking keeps working on the single shared
 * agenda exactly as before.
 */
export async function getClinicDirectory(
  db: SupabaseClient,
  accountId: string,
): Promise<ClinicDirectory | null> {
  try {
    if (!(await accountModuleEnabled(db, accountId, 'clinic'))) return null
    const today = businessToday()
    const [{ data, error }, specialtiesRes, timeOffRes, servicesRes, settingsRes] = await Promise.all([
      db
        .from('professionals')
        .select('id, name, bio, active, hours, slot_minutes, sort_order, professional_specialties(specialty:specialties(name))')
        .eq('account_id', accountId)
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }),
      db.from('specialties').select('name').eq('account_id', accountId).order('name', { ascending: true }),
      // Migration 067 tables/columns: a missing one just means "none".
      db
        .from('professional_time_off')
        .select('professional_id, starts_on, ends_on')
        .eq('account_id', accountId)
        .gte('ends_on', today)
        .order('starts_on', { ascending: true }),
      db
        .from('clinic_services')
        .select('id, name, description, duration_minutes, price, specialty:specialties(name)')
        .eq('account_id', accountId)
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }),
      db.from('accounts').select('clinic_settings').eq('id', accountId).maybeSingle(),
    ])
    if (error) {
      if (!missingSchema(error.code)) console.error('[clinic] directory load failed:', error)
      return null
    }
    const timeOff = new Map<string, { from: string; to: string }[]>()
    for (const row of (timeOffRes.error ? [] : (timeOffRes.data ?? [])) as TimeOffRow[]) {
      const list = timeOff.get(row.professional_id) ?? []
      list.push({ from: row.starts_on, to: row.ends_on })
      timeOff.set(row.professional_id, list)
    }
    const professionals = ((data ?? []) as unknown as ProfessionalRow[]).map((p) => ({
      id: p.id,
      name: p.name,
      bio: p.bio,
      hours: hasOpenDay(p.hours) ? p.hours : null,
      slotMinutes: p.slot_minutes && p.slot_minutes > 0 ? p.slot_minutes : null,
      specialties: (p.professional_specialties ?? [])
        .map((ps) => ps.specialty?.name)
        .filter((n): n is string => !!n)
        .sort((a, b) => a.localeCompare(b)),
      timeOff: timeOff.get(p.id) ?? [],
    }))
    if (professionals.length === 0) return null
    const specialties = ((specialtiesRes.data ?? []) as { name: string }[]).map((s) => s.name)
    const services = ((servicesRes.error ? [] : (servicesRes.data ?? [])) as unknown as ServiceRow[]).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      specialty: s.specialty?.name ?? null,
      durationMinutes: s.duration_minutes,
      price: s.price === null || s.price === undefined ? null : Number(s.price),
    }))
    const insurance = normalizeClinicSettings(
      settingsRes.error ? null : (settingsRes.data as { clinic_settings?: unknown } | null)?.clinic_settings,
    )
    return { professionals, specialties, services, insurance }
  } catch (err) {
    console.error('[clinic] directory load threw:', err)
    return null
  }
}

/** Lowercase, accent-free, collapsed whitespace — "Pediatría" ≈ "pediatria". */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/** Titles people put in front of a doctor's name, ignored when matching. */
const TITLE_WORDS = new Set(['dr', 'dra', 'doctor', 'doctora', 'lic', 'licda', 'licdo', 'dr.', 'dra.'])

function nameWords(value: string): string[] {
  return normalizeText(value)
    .replace(/[.,]/g, ' ')
    .split(' ')
    .filter((w) => w && !TITLE_WORDS.has(w))
}

/** The doctor's name without the "Dr./Dra." title, for short labels. */
export function shortProfessionalName(name: string): string {
  const words = name.trim().split(/\s+/)
  const first = words[0] ? normalizeText(words[0]).replace(/\./g, '') : ''
  return (TITLE_WORDS.has(first) && words.length > 1 ? words.slice(1) : words).join(' ')
}

function specialtyMatches(professional: ClinicProfessional, specialty: string): boolean {
  const wanted = normalizeText(specialty)
  if (!wanted) return true
  return professional.specialties.some((s) => {
    const have = normalizeText(s)
    return have.includes(wanted) || wanted.includes(have)
  })
}

function nameMatches(professional: ClinicProfessional, query: string): boolean {
  const wanted = nameWords(query)
  if (wanted.length === 0) return false
  const have = nameWords(professional.name)
  return wanted.every((w) => have.some((h) => h.startsWith(w)))
}

/**
 * Doctors matching a free-text query (a name or a specialty) and/or a
 * specialty. With neither, every active doctor.
 */
export function searchProfessionals(
  directory: ClinicDirectory,
  args: { query?: string; specialty?: string },
): ClinicProfessional[] {
  const query = args.query?.trim() ?? ''
  const specialty = args.specialty?.trim() ?? ''
  return directory.professionals.filter((p) => {
    if (specialty && !specialtyMatches(p, specialty)) return false
    if (query && !nameMatches(p, query) && !specialtyMatches(p, query)) return false
    return true
  })
}

/** Resolve what the model passed as `professional_id` — normally the id,
 *  but a name is accepted too, as long as it matches exactly one doctor. */
export function resolveProfessional(
  directory: ClinicDirectory,
  idOrName: string | undefined | null,
): ClinicProfessional | null {
  const value = idOrName?.trim()
  if (!value) return null
  const byId = directory.professionals.find((p) => p.id === value)
  if (byId) return byId
  const byName = directory.professionals.filter((p) => nameMatches(p, value))
  return byName.length === 1 ? byName[0] : null
}

const WEEKDAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const
const WEEKDAY_SHORT: Record<(typeof WEEKDAY_ORDER)[number], string> = {
  monday: 'Mon',
  tuesday: 'Tue',
  wednesday: 'Wed',
  thursday: 'Thu',
  friday: 'Fri',
  saturday: 'Sat',
  sunday: 'Sun',
}

/** "Mon-Fri 08:00-12:00; Sat 09:00-13:00", or null for business hours. */
export function formatProfessionalHours(hours: WeeklyHours | null): string | null {
  if (!hours) return null
  const groups: { label: string; days: string[] }[] = []
  for (const day of WEEKDAY_ORDER) {
    const h = hours[day]
    if (!h) continue
    const label = `${h.open}-${h.close}`
    const last = groups[groups.length - 1]
    const prevDay = WEEKDAY_ORDER[WEEKDAY_ORDER.indexOf(day) - 1]
    if (last && last.label === label && prevDay && last.days[last.days.length - 1] === WEEKDAY_SHORT[prevDay]) {
      last.days.push(WEEKDAY_SHORT[day])
    } else {
      groups.push({ label, days: [WEEKDAY_SHORT[day]] })
    }
  }
  if (groups.length === 0) return null
  return groups
    .map((g) => `${g.days.length > 1 ? `${g.days[0]}-${g.days[g.days.length - 1]}` : g.days[0]} ${g.label}`)
    .join('; ')
}

/** What `find_professionals` shows the model for one doctor. */
export function professionalSummary(p: ClinicProfessional) {
  return {
    professional_id: p.id,
    name: p.name,
    specialties: p.specialties,
    hours: formatProfessionalHours(p.hours) ?? 'same as the business hours',
    ...(p.timeOff && p.timeOff.length > 0 ? { away: p.timeOff } : {}),
    ...(p.bio ? { about: p.bio } : {}),
  }
}

/** Doctors listed in the system prompt; past this, the model relies on
 *  `find_professionals`. */
const PROMPT_ROSTER_LIMIT = 40

/** "away 2026-10-12 to 2026-10-16" for a doctor's upcoming days off. */
function formatTimeOff(timeOff: { from: string; to: string }[] | undefined): string | null {
  if (!timeOff || timeOff.length === 0) return null
  return `away ${timeOff.map((r) => (r.from === r.to ? r.from : `${r.from} to ${r.to}`)).join(', ')}`
}

/** "RD$1,500" style price, or null. */
function formatPrice(price: number | null): string | null {
  if (price === null || !Number.isFinite(price)) return null
  return `RD$${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

/** The roster block for the system prompt: one line per doctor with the
 *  id the booking tools need, then the services and the insurance rules. */
export function formatClinicRoster(directory: ClinicDirectory): string {
  const lines = directory.professionals.slice(0, PROMPT_ROSTER_LIMIT).map((p) => {
    const specialties = p.specialties.length > 0 ? p.specialties.join(', ') : 'general'
    const hours = formatProfessionalHours(p.hours)
    const away = formatTimeOff(p.timeOff)
    return `- ${p.name} — ${specialties}${hours ? ` — hours: ${hours}` : ''}${away ? ` — ${away}` : ''} (professional_id: ${p.id})`
  })
  const more = directory.professionals.length - lines.length
  let roster = lines.join('\n') + (more > 0 ? `\n…and ${more} more; use find_professionals to search them.` : '')

  const services = directory.services ?? []
  if (services.length > 0) {
    roster +=
      '\nServices (each has its own length; only these exist):\n' +
      services
        .map((s) => {
          const details = [s.specialty ? `${s.specialty} only` : 'any doctor', `${s.durationMinutes} min`, formatPrice(s.price)]
            .filter(Boolean)
            .join(', ')
          return `- ${s.name} — ${details}${s.description ? ` — ${s.description}` : ''} (service_id: ${s.id})`
        })
        .join('\n') +
      '\nFind out which service the customer needs and pass its service_id to check_availability and book_appointment, so the slots have the right length and only doctors who offer it are searched.'
  }

  const insurance = directory.insurance
  if (insurance?.ask) {
    roster +=
      '\nHealth insurance: before booking, ask whether the customer will use a health insurance (ARS) and, if so, which one and their affiliate number. ' +
      (insurance.insurers.length > 0
        ? `The clinic only accepts these insurers: ${insurance.insurers.join(', ')}. If theirs is not on the list, say so kindly and offer the appointment as private (paid by the patient). `
        : '') +
      'Pass it in book_appointment as insurance (e.g. "Humano, afiliado 123456"), or "privado" when they pay themselves.'
  }
  return roster
}

/** Resolve what the model passed as `service_id`: the id, or a name
 *  matching exactly one service. */
export function resolveService(
  directory: ClinicDirectory,
  idOrName: string | undefined | null,
): ClinicService | null {
  const value = idOrName?.trim()
  if (!value) return null
  const services = directory.services ?? []
  const byId = services.find((s) => s.id === value)
  if (byId) return byId
  const wanted = normalizeText(value)
  const byName = services.filter((s) => normalizeText(s.name) === wanted)
  return byName.length === 1 ? byName[0] : null
}

/** Whether a doctor offers a service (its specialty, or any doctor). */
export function professionalOffersService(professional: ClinicProfessional, service: ClinicService): boolean {
  if (!service.specialty) return true
  return specialtyMatches(professional, service.specialty)
}

/** Whether `dateISO` (business-local) falls on one of the doctor's days off. */
export function isOnTimeOff(professional: ClinicProfessional, dateISO: string): boolean {
  return (professional.timeOff ?? []).some((r) => dateISO >= r.from && dateISO <= r.to)
}

/** The clinic half of the booking tools over a loaded directory:
 *  `find_professionals`, plus which optional arguments to expose. */
export function clinicSearchTool(directory: ClinicDirectory) {
  return {
    find: (args: { query?: string; specialty?: string }) =>
      searchProfessionals(directory, args).map(professionalSummary),
    services: (directory.services ?? []).length > 0,
    insurance: !!directory.insurance?.ask,
  }
}
