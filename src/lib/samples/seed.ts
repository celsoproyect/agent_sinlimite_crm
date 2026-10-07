import type { SupabaseClient } from '@supabase/supabase-js'
import type { ReminderAppliesTo, ReminderRuleKind } from '@/types'
import { businessLocalToInstant, businessToday } from '@/lib/business-timezone'
import { addDaysISO } from '@/lib/bookings/ranges'
import { DEFAULT_RESTAURANT_SETTINGS } from '@/lib/restaurant/settings'
import { DEFAULT_EVENT_SETTINGS } from '@/lib/events/settings'

// ============================================================
// "Cargar ejemplos" (migration 068). Each module gets a small, realistic
// set of rows flagged `is_sample` that shows what to fill in and how it
// works: tables and areas, halls and packages, doctors and services,
// reminder and follow-up rules, and bookings in every state.
//
// Safety:
//  - Example contacts get phones in the 809-000 exchange, which no real
//    line uses, and the reminder drain skips sample bookings, contacts
//    and rules, so nothing is ever sent to them.
//  - Example rules never send until the owner presses "Usar esta regla".
//  - The AI only sees example tables/halls/doctors while the business has
//    none of its own (`preferReal`).
//  - Loading again replaces the previous examples; removing deletes only
//    rows flagged `is_sample`.
// ============================================================

export type SampleModule = 'restaurant' | 'events' | 'clinic' | 'reminders'
export const SAMPLE_MODULES: SampleModule[] = ['restaurant', 'events', 'clinic', 'reminders']

export class SampleError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 500,
  ) {
    super(message)
  }
}

const MISSING = new Set(['42703', '42P01', 'PGRST200', 'PGRST204', 'PGRST205'])

function fail(error: { code?: string; message: string } | null, what: string): never {
  if (error?.code && MISSING.has(error.code)) {
    throw new SampleError('Run migration 068 first.', 'needs_migration', 503)
  }
  throw new SampleError(`${what}: ${error?.message ?? 'unknown error'}`, 'sample_failed')
}

interface Ctx {
  db: SupabaseClient
  accountId: string
  userId: string
}

/** A business-local day `offset` days from today at HH:mm, as an ISO instant. */
function at(offset: number, hhmm: string): string {
  return businessLocalToInstant(addDaysISO(businessToday(), offset), hhmm).toISOString()
}

function plusMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString()
}

/** Example customers. Phones in 809-000-xxxx: an exchange no real line has. */
async function sampleContacts(ctx: Ctx, module: SampleModule, names: string[]): Promise<{ id: string; name: string; phone: string }[]> {
  const block = { restaurant: 1, events: 2, clinic: 3, reminders: 4 }[module]
  const rows = names.map((name, i) => ({
    account_id: ctx.accountId,
    user_id: ctx.userId,
    name: `${name} (ejemplo)`,
    phone: `+1809000${block}${String(i + 1).padStart(3, '0')}`,
    is_sample: true,
  }))
  const { data, error } = await ctx.db.from('contacts').insert(rows).select('id, name, phone')
  if (error || !data) fail(error, 'contacts')
  return data as { id: string; name: string; phone: string }[]
}

async function insertRows<T>(ctx: Ctx, table: string, rows: Record<string, unknown>[], select = 'id, name'): Promise<T[]> {
  if (rows.length === 0) return []
  const { data, error } = await ctx.db.from(table).insert(rows).select(select)
  if (error || !data) fail(error, table)
  return data as T[]
}

/** Fill a settings column only while the business hasn't saved its own. */
async function seedSettingsIfEmpty(ctx: Ctx, column: string, value: Record<string, unknown>): Promise<boolean> {
  const { data, error } = await ctx.db.from('accounts').select(column).eq('id', ctx.accountId).maybeSingle()
  if (error) fail(error, column)
  const current = (data as Record<string, unknown> | null)?.[column]
  if (current && typeof current === 'object' && Object.keys(current).length > 0) return false
  const { data: updated, error: upErr } = await ctx.db.from('accounts').update({ [column]: value }).eq('id', ctx.accountId).select('id')
  if (upErr) fail(upErr, column)
  return (updated ?? []).length > 0
}

// ---------- restaurant ----------

async function seedRestaurant(ctx: Ctx): Promise<Record<string, number | boolean>> {
  const areas = await insertRows<{ id: string; name: string }>(ctx, 'restaurant_areas', [
    { account_id: ctx.accountId, name: 'Salón principal (ejemplo)', description: 'Interior con aire acondicionado', sort_order: 1, is_sample: true },
    { account_id: ctx.accountId, name: 'Terraza (ejemplo)', description: 'Al aire libre, área de fumadores', sort_order: 2, is_sample: true },
  ])
  const [salon, terraza] = areas
  const tableSpecs: [string, string, number, number, boolean][] = [
    // name, area, min, max, combinable
    ['Mesa 1 (ejemplo)', salon.id, 1, 2, true],
    ['Mesa 2 (ejemplo)', salon.id, 1, 2, true],
    ['Mesa 3 (ejemplo)', salon.id, 2, 4, true],
    ['Mesa 4 (ejemplo)', salon.id, 2, 4, true],
    ['Mesa 5 (ejemplo)', salon.id, 2, 4, true],
    ['Mesa 6 (ejemplo)', salon.id, 4, 6, false],
    ['Terraza 1 (ejemplo)', terraza.id, 2, 4, true],
    ['Terraza 2 (ejemplo)', terraza.id, 2, 4, true],
  ]
  const tables = await insertRows<{ id: string; name: string }>(
    ctx,
    'restaurant_tables',
    tableSpecs.map(([name, area_id, min_party, max_party, combinable], i) => ({
      account_id: ctx.accountId,
      area_id,
      name,
      min_party,
      max_party,
      combinable,
      sort_order: i + 1,
      notes: combinable ? null : 'Mesa redonda: no se junta con otras',
      is_sample: true,
    })),
  )
  const byName = new Map(tables.map((t) => [t.name.replace(' (ejemplo)', ''), t]))

  const settingsSeeded = await seedSettingsIfEmpty(ctx, 'restaurant_settings', {
    ...DEFAULT_RESTAURANT_SETTINGS,
    hours: {
      tuesday: { open: '12:00', close: '23:00' },
      wednesday: { open: '12:00', close: '23:00' },
      thursday: { open: '12:00', close: '23:00' },
      friday: { open: '12:00', close: '23:59' },
      saturday: { open: '12:00', close: '23:59' },
      sunday: { open: '12:00', close: '22:00' },
    },
  })

  const contacts = await sampleContacts(ctx, 'restaurant', ['María Gómez', 'Carlos Rodríguez', 'Laura Martínez', 'José Fernández', 'Ana Castillo'])
  const minutes = DEFAULT_RESTAURANT_SETTINGS.default_duration_minutes
  const specs: {
    contact: number
    start: string
    duration?: number
    party: number
    tables: string[]
    seating: 'single' | 'joined' | 'separate'
    status?: string
    occasion?: string
    notes?: string
    preorder?: { item: string; qty: number; notes?: string }[]
  }[] = [
    { contact: 0, start: at(0, '20:00'), party: 4, tables: ['Mesa 3'], seating: 'single', notes: 'Prefiere cerca de la ventana' },
    {
      contact: 1,
      start: at(1, '13:00'),
      party: 8,
      tables: ['Mesa 4', 'Mesa 5'],
      seating: 'joined',
      occasion: 'Almuerzo de oficina',
      notes: 'Grupo de 8: el cliente aceptó dos mesas juntas.',
    },
    {
      contact: 2,
      start: at(2, '19:30'),
      duration: 150,
      party: 2,
      tables: ['Terraza 1'],
      seating: 'single',
      occasion: 'Aniversario',
      notes: 'Pidió 2 h 30 min en lugar de 90 min. Traen pastel.',
      preorder: [
        { item: 'Botella de vino tinto de la casa', qty: 1 },
        { item: 'Postre especial con vela', qty: 1, notes: 'Al final de la cena' },
      ],
    },
    {
      contact: 3,
      start: at(3, '20:30'),
      party: 6,
      tables: ['Mesa 1', 'Mesa 2'],
      seating: 'separate',
      notes: 'Grupo de 6 en mesas separadas, una al lado de la otra (lo prefirió así).',
    },
    { contact: 4, start: at(-1, '21:00'), party: 2, tables: ['Mesa 2'], seating: 'single', status: 'no_show', notes: 'No llegó ni avisó.' },
    { contact: 0, start: at(-2, '14:00'), party: 3, tables: ['Mesa 4'], seating: 'single', status: 'completed' },
  ]

  let bookings = 0
  for (const s of specs) {
    const c = contacts[s.contact]
    const ids = s.tables.map((n) => byName.get(n)!.id)
    const endsAt = plusMinutes(s.start, s.duration ?? minutes)
    const [booking] = await insertRows<{ id: string }>(
      ctx,
      'bookings',
      [
        {
          account_id: ctx.accountId,
          contact_id: c.id,
          kind: 'table',
          service: `Mesa para ${s.party} (${s.tables.join(' + ')})`,
          starts_at: s.start,
          ends_at: endsAt,
          status: s.status ?? 'confirmed',
          party_size: s.party,
          seating: s.seating,
          occasion: s.occasion ?? null,
          notes: s.notes ?? null,
          preorder: s.preorder ?? null,
          customer_name: c.name,
          customer_phone: c.phone,
          created_by: ctx.userId,
          is_sample: true,
        },
      ],
      'id',
    )
    const released = s.status === 'no_show'
    const { error } = await ctx.db.from('booking_tables').insert(
      ids.map((table_id) => ({ booking_id: booking.id, table_id, account_id: ctx.accountId, starts_at: s.start, ends_at: endsAt, released })),
    )
    if (error) fail(error, 'booking_tables')
    bookings++
  }

  const today = businessToday()
  const waitlist = await insertRows(
    ctx,
    'restaurant_waitlist',
    [
      {
        account_id: ctx.accountId,
        contact_id: contacts[1].id,
        customer_name: contacts[1].name,
        customer_phone: contacts[1].phone,
        party_size: 4,
        date: today,
        preferred_time: '20:00',
        notes: 'Si se libera algo entre 19:30 y 21:00',
        is_sample: true,
      },
      {
        account_id: ctx.accountId,
        contact_id: contacts[2].id,
        customer_name: contacts[2].name,
        customer_phone: contacts[2].phone,
        party_size: 2,
        date: addDaysISO(today, 1),
        preferred_time: '21:00',
        status: 'notified',
        is_sample: true,
      },
    ],
    'id',
  )

  return { areas: areas.length, tables: tables.length, bookings, waitlist: waitlist.length, settings: settingsSeeded }
}

// ---------- events ----------

async function seedEvents(ctx: Ctx): Promise<Record<string, number | boolean>> {
  const halls = await insertRows<{ id: string; name: string }>(ctx, 'event_halls', [
    {
      account_id: ctx.accountId,
      name: 'Salón Jardín (ejemplo)',
      description: 'Salón con jardín para bodas y cumpleaños grandes. Incluye mesas, sillas y sonido básico.',
      capacity_min: 40,
      capacity_max: 150,
      price_per_hour: 9000,
      min_hours: 4,
      setup_minutes: 90,
      cleanup_minutes: 60,
      // null = use the general settings (approval and deposit %).
      requires_approval: null,
      deposit_percent: null,
      sort_order: 1,
      is_sample: true,
    },
    {
      account_id: ctx.accountId,
      name: 'Salón Privado (ejemplo)',
      description: 'Sala cerrada para reuniones y cenas privadas, con pantalla y aire acondicionado.',
      capacity_min: 10,
      capacity_max: 40,
      price_per_hour: 3500,
      min_hours: 3,
      setup_minutes: 30,
      cleanup_minutes: 30,
      // This hall needs no approval and asks 50% instead of the general %.
      requires_approval: false,
      deposit_percent: 50,
      sort_order: 2,
      is_sample: true,
    },
  ])
  const [jardin, privado] = halls
  const packages = await insertRows<{ id: string; name: string }>(ctx, 'event_packages', [
    {
      account_id: ctx.accountId,
      hall_id: jardin.id,
      name: 'Cumpleaños Clásico (ejemplo)',
      description: 'Decoración básica, bizcocho, picadera y refrescos. 4 horas.',
      price: 15000,
      price_per_person: 950,
      min_guests: 40,
      max_guests: 120,
      duration_hours: 4,
      sort_order: 1,
      is_sample: true,
    },
    {
      account_id: ctx.accountId,
      hall_id: jardin.id,
      name: 'Boda Premium (ejemplo)',
      description: 'Ceremonia y recepción, menú de 3 tiempos, barra libre nacional y DJ. 6 horas.',
      price: 85000,
      price_per_person: 2800,
      min_guests: 80,
      max_guests: 150,
      duration_hours: 6,
      sort_order: 2,
      is_sample: true,
    },
    {
      account_id: ctx.accountId,
      hall_id: privado.id,
      name: 'Reunión Corporativa (ejemplo)',
      description: 'Medio día con coffee break y almuerzo. Precio cerrado.',
      price: 42000,
      price_per_person: null,
      min_guests: 10,
      max_guests: 40,
      duration_hours: 4,
      sort_order: 3,
      is_sample: true,
    },
  ])
  const [cumple, boda, corporativo] = packages

  const settingsSeeded = await seedSettingsIfEmpty(ctx, 'event_settings', {
    ...DEFAULT_EVENT_SETTINGS,
    requires_approval: true,
    deposit_required: true,
    deposit_percent: 30,
    deposit_instructions:
      'EJEMPLO — cámbialo por tus datos: transferencia a Banco Ejemplo, cuenta corriente 000-000000-0 a nombre de Tu Negocio SRL. Envía el comprobante por este chat.',
  })

  const contacts = await sampleContacts(ctx, 'events', ['Paola Reyes', 'Inversiones Caribe', 'Luis Peña', 'Familia Santos', 'Rosa Jiménez', 'Pedro Almonte'])
  // Every stage of the flow: Solicitud → Cotizado → Depósito pagado →
  // Confirmado → Realizado, plus a cancelled one.
  const specs = [
    { c: 0, hall: jardin, pkg: boda, type: 'Boda', day: 45, time: '17:00', hours: 6, guests: 120, status: 'requested', total: 85000 + 2800 * 120, notes: 'Pide ver el salón un sábado.' },
    { c: 1, hall: privado, pkg: corporativo, type: 'Corporativo', day: 12, time: '08:00', hours: 4, guests: 25, status: 'quoted', total: 42000, notes: 'Necesitan proyector.' },
    { c: 2, hall: jardin, pkg: cumple, type: 'Cumpleaños', day: 8, time: '16:00', hours: 4, guests: 60, status: 'deposit_paid', total: 15000 + 950 * 60, notes: 'Tema: superhéroes.' },
    { c: 3, hall: jardin, pkg: null, type: 'Graduación', day: 4, time: '18:00', hours: 5, guests: 80, status: 'confirmed', total: 9000 * 5, notes: 'Solo el salón; ellos traen la comida.' },
    { c: 4, hall: privado, pkg: null, type: 'Baby shower', day: -6, time: '15:00', hours: 3, guests: 20, status: 'completed', total: 3500 * 3, notes: null },
    { c: 5, hall: privado, pkg: corporativo, type: 'Corporativo', day: 20, time: '09:00', hours: 4, guests: 15, status: 'cancelled', total: 42000, notes: 'Canceló: cambiaron la fecha del congreso.' },
  ] as const

  let bookings = 0
  for (const s of specs) {
    const c = contacts[s.c]
    const start = at(s.day, s.time)
    const pct = s.hall === privado ? 50 : 30
    const deposit = Math.round(s.total * pct) / 100
    await insertRows(
      ctx,
      'bookings',
      [
        {
          account_id: ctx.accountId,
          contact_id: c.id,
          kind: 'event',
          service: `${s.type} · ${s.hall.name} · ${s.guests} invitados`,
          starts_at: start,
          ends_at: plusMinutes(start, s.hours * 60),
          status: s.status === 'cancelled' ? 'cancelled' : s.status === 'completed' ? 'completed' : 'confirmed',
          party_size: s.guests,
          event_type: s.type,
          event_status: s.status,
          event_hall_id: s.hall.id,
          event_package_id: s.pkg?.id ?? null,
          quote_amount: s.status === 'requested' ? null : s.total,
          deposit_amount: s.status === 'requested' ? null : deposit,
          deposit_paid_at: ['deposit_paid', 'confirmed', 'completed'].includes(s.status) ? at(Math.min(s.day, 0) - 3, '10:00') : null,
          currency: 'DOP',
          notes: s.notes,
          customer_name: c.name,
          customer_phone: c.phone,
          created_by: ctx.userId,
          is_sample: true,
        },
      ],
      'id',
    )
    bookings++
  }
  return { halls: halls.length, packages: packages.length, bookings, settings: settingsSeeded }
}

// ---------- clinic ----------

async function seedClinic(ctx: Ctx): Promise<Record<string, number | boolean>> {
  // Reuse a specialty the clinic already has; create the missing ones.
  const wanted = ['Medicina general', 'Pediatría', 'Odontología']
  const { data: existing, error: specErr } = await ctx.db.from('specialties').select('id, name').eq('account_id', ctx.accountId)
  if (specErr) fail(specErr, 'specialties')
  const known = new Map(((existing ?? []) as { id: string; name: string }[]).map((s) => [s.name.toLowerCase(), s.id]))
  const created = await insertRows<{ id: string; name: string }>(
    ctx,
    'specialties',
    wanted.filter((n) => !known.has(n.toLowerCase())).map((name) => ({ account_id: ctx.accountId, name, is_sample: true })),
  )
  for (const s of created) known.set(s.name.toLowerCase(), s.id)
  const spec = (name: string) => known.get(name.toLowerCase())!

  const weekdays = (open: string, close: string) =>
    Object.fromEntries(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => [d, { open, close }]))
  const doctors = await insertRows<{ id: string; name: string }>(ctx, 'professionals', [
    { account_id: ctx.accountId, name: 'Dra. Ana Pérez (ejemplo)', bio: 'Medicina general y chequeos preventivos.', hours: weekdays('08:00', '13:00'), slot_minutes: 20, sort_order: 1, is_sample: true },
    { account_id: ctx.accountId, name: 'Dr. Miguel Torres (ejemplo)', bio: 'Pediatra. Atiende niños de 0 a 15 años.', hours: weekdays('14:00', '18:00'), slot_minutes: 30, sort_order: 2, is_sample: true },
    { account_id: ctx.accountId, name: 'Dra. Carmen Díaz (ejemplo)', bio: 'Odontología general y limpiezas.', hours: null, slot_minutes: 30, sort_order: 3, is_sample: true },
  ])
  const [ana, miguel, carmen] = doctors
  const { error: linkErr } = await ctx.db.from('professional_specialties').insert([
    { professional_id: ana.id, specialty_id: spec('Medicina general') },
    { professional_id: miguel.id, specialty_id: spec('Pediatría') },
    { professional_id: carmen.id, specialty_id: spec('Odontología') },
  ])
  if (linkErr) fail(linkErr, 'professional_specialties')

  // Migration 067 pieces: skipped quietly when it hasn't run.
  let services = 0
  const { data: svc, error: svcErr } = await ctx.db
    .from('clinic_services')
    .insert([
      { account_id: ctx.accountId, name: 'Consulta general (ejemplo)', specialty_id: spec('Medicina general'), duration_minutes: 20, price: 1500, sort_order: 1, is_sample: true },
      { account_id: ctx.accountId, name: 'Consulta pediátrica (ejemplo)', specialty_id: spec('Pediatría'), duration_minutes: 30, price: 2000, sort_order: 2, is_sample: true },
      { account_id: ctx.accountId, name: 'Limpieza dental (ejemplo)', specialty_id: spec('Odontología'), duration_minutes: 60, price: 2500, sort_order: 3, is_sample: true },
    ])
    .select('id, name')
  if (!svcErr) services = (svc ?? []).length
  const svcId = (prefix: string) => ((svc ?? []) as { id: string; name: string }[]).find((s) => s.name.startsWith(prefix))?.id ?? null
  await ctx.db.from('professional_time_off').insert({
    account_id: ctx.accountId,
    professional_id: carmen.id,
    starts_on: addDaysISO(businessToday(), 10),
    ends_on: addDaysISO(businessToday(), 14),
    reason: 'Vacaciones (ejemplo)',
  })

  const contacts = await sampleContacts(ctx, 'clinic', ['Juana Mejía', 'Roberto Sánchez', 'Sofía Vargas', 'Andrés Polanco'])
  const specs = [
    { c: 0, doc: ana, svc: 'Consulta general', day: 1, time: '09:00', mins: 20, status: 'confirmed', insurance: 'ARS Ejemplo · afiliado 000123' },
    { c: 1, doc: miguel, svc: 'Consulta pediátrica', day: 2, time: '15:00', mins: 30, status: 'confirmed', insurance: 'Privado' },
    { c: 2, doc: carmen, svc: 'Limpieza dental', day: 3, time: '10:00', mins: 60, status: 'confirmed', insurance: null },
    { c: 3, doc: ana, svc: 'Consulta general', day: -1, time: '10:20', mins: 20, status: 'completed', insurance: null },
    { c: 1, doc: miguel, svc: 'Consulta pediátrica', day: -3, time: '16:00', mins: 30, status: 'no_show', insurance: null },
  ] as const
  let bookings = 0
  for (const s of specs) {
    const c = contacts[s.c]
    const start = at(s.day, s.time)
    const base = {
      account_id: ctx.accountId,
      contact_id: c.id,
      kind: 'appointment',
      service: `${s.svc} · ${s.doc.name}`,
      starts_at: start,
      ends_at: plusMinutes(start, s.mins),
      status: s.status,
      professional_id: s.doc.id,
      customer_name: c.name,
      customer_phone: c.phone,
      created_by: ctx.userId,
      is_sample: true,
    }
    const extra = { clinic_service_id: svcId(s.svc), insurance: s.insurance }
    let { error } = await ctx.db.from('bookings').insert({ ...base, ...extra })
    if (error?.code === '42703') ({ error } = await ctx.db.from('bookings').insert(base))
    if (error) fail(error, 'bookings')
    bookings++
  }
  return { specialties: created.length, doctors: doctors.length, services, bookings }
}

// ---------- reminders and follow-ups ----------

interface RuleSpec {
  kind: ReminderRuleKind
  applies_to: ReminderAppliesTo
  offset_minutes: number
  message_text: string
}

export const SAMPLE_RULES: RuleSpec[] = [
  // Doctors / agenda appointments
  {
    kind: 'before',
    applies_to: 'appointment',
    offset_minutes: 1440,
    message_text:
      'Hola {{contact_name}} 👋 Te recordamos tu cita de {{service}} mañana {{date}} a las {{time}}. Código: {{reference}}. Responde CONFIRMO, o escríbenos si necesitas cambiarla.',
  },
  {
    kind: 'before',
    applies_to: 'appointment',
    offset_minutes: 120,
    message_text: 'Hola {{contact_name}}, te esperamos hoy a las {{time}}. Llega 10 minutos antes y trae tu cédula y carnet del seguro.',
  },
  {
    kind: 'after',
    applies_to: 'appointment',
    offset_minutes: 1440,
    message_text:
      'Hola {{contact_name}}, ¿cómo te has sentido después de tu cita de ayer? Si tienes alguna duda o quieres agendar tu control, respóndenos por aquí.',
  },
  // Restaurant tables
  {
    kind: 'before',
    applies_to: 'table',
    offset_minutes: 180,
    message_text:
      'Hola {{contact_name}} 🍽️ Te esperamos hoy a las {{time}}, mesa para {{party_size}} ({{tables}}). Código: {{reference}}. Guardamos la mesa 15 minutos; si se retrasan, avísanos.',
  },
  {
    kind: 'after',
    applies_to: 'table',
    offset_minutes: 120,
    message_text: '¡Gracias por visitarnos, {{contact_name}}! ¿Qué tal estuvo todo? Tu opinión nos ayuda mucho. ¡Te esperamos pronto!',
  },
  // Events
  {
    kind: 'before',
    applies_to: 'event',
    offset_minutes: 10080,
    message_text:
      'Hola {{contact_name}} 🎉 Falta una semana para tu evento en {{hall}} el {{date}} a las {{time}} ({{party_size}} invitados). Código: {{reference}}. Confírmanos el número final de invitados y el saldo pendiente.',
  },
  {
    kind: 'before',
    applies_to: 'event',
    offset_minutes: 1440,
    message_text: 'Hola {{contact_name}}, ¡mañana es tu evento en {{hall}}! El salón estará listo a partir de las {{time}}. Cualquier detalle de última hora, escríbenos.',
  },
  {
    kind: 'after',
    applies_to: 'event',
    offset_minutes: 1440,
    message_text:
      'Hola {{contact_name}}, gracias por celebrar con nosotros 💛 ¿Cómo les fue? Si nos compartes fotos o una reseña te lo agradecemos, y si tienes otro evento en mente, aquí estamos.',
  },
]

async function seedReminders(ctx: Ctx, scope: ReminderAppliesTo | null): Promise<Record<string, number>> {
  let created = 0
  let skipped = 0
  for (const r of SAMPLE_RULES.filter((r) => !scope || scope === 'all' || r.applies_to === scope)) {
    const { error } = await ctx.db
      .from('booking_reminder_rules')
      .insert({ account_id: ctx.accountId, ...r, enabled: true, is_sample: true })
    if (!error) created++
    else if (error.code === '23505') skipped++ // the business already has a rule at that time
    else fail(error, 'booking_reminder_rules')
  }
  return { rules: created, skipped }
}

// ---------- removal ----------

async function del(ctx: Ctx, table: string, apply?: (q: ReturnType<ReturnType<SupabaseClient['from']>['delete']>) => unknown) {
  let q = ctx.db.from(table).delete().eq('account_id', ctx.accountId).eq('is_sample', true)
  if (apply) q = apply(q) as typeof q
  const { error } = await q
  if (error && !MISSING.has(error.code ?? '')) fail(error, table)
}

/** Delete one module's examples. Real rows are never touched. */
export async function removeSamples(ctx: Ctx, module: SampleModule, scope: ReminderAppliesTo | null = null): Promise<void> {
  if (module === 'reminders') {
    await del(ctx, 'booking_reminder_rules', scope && scope !== 'all' ? (q) => q.eq('applies_to', scope) : undefined)
    return
  }
  const kind = module === 'restaurant' ? 'table' : module === 'events' ? 'event' : 'appointment'
  await del(ctx, 'bookings', (q) => q.eq('kind', kind))
  if (module === 'restaurant') {
    await del(ctx, 'restaurant_waitlist')
    await del(ctx, 'restaurant_tables')
    await del(ctx, 'restaurant_areas')
  } else if (module === 'events') {
    await del(ctx, 'event_packages')
    await del(ctx, 'event_halls')
  } else {
    await del(ctx, 'clinic_services')
    await del(ctx, 'professionals')
    await del(ctx, 'specialties')
  }
  await removeOrphanSampleContacts(ctx)
}

/** Example contacts no example booking or waitlist entry points at any more. */
async function removeOrphanSampleContacts(ctx: Ctx): Promise<void> {
  const { data, error } = await ctx.db.from('contacts').select('id').eq('account_id', ctx.accountId).eq('is_sample', true)
  if (error) return
  const ids = ((data ?? []) as { id: string }[]).map((c) => c.id)
  if (ids.length === 0) return
  const [b, w] = await Promise.all([
    ctx.db.from('bookings').select('contact_id').in('contact_id', ids),
    ctx.db.from('restaurant_waitlist').select('contact_id').in('contact_id', ids),
  ])
  const used = new Set([...((b.data ?? []) as { contact_id: string }[]), ...((w.data ?? []) as { contact_id: string }[])].map((r) => r.contact_id))
  const orphans = ids.filter((id) => !used.has(id))
  if (orphans.length) await ctx.db.from('contacts').delete().in('id', orphans).eq('is_sample', true)
}

/** Replace one module's examples with a fresh set. */
export async function loadSamples(ctx: Ctx, module: SampleModule, scope: ReminderAppliesTo | null = null): Promise<Record<string, number | boolean>> {
  await removeSamples(ctx, module, scope)
  switch (module) {
    case 'restaurant':
      return seedRestaurant(ctx)
    case 'events':
      return seedEvents(ctx)
    case 'clinic':
      return seedClinic(ctx)
    case 'reminders':
      return seedReminders(ctx, scope)
  }
}

/** How many example rows each module has, for the "Quitar ejemplos" buttons. */
export async function countSamples(ctx: Ctx): Promise<Record<SampleModule, number>> {
  const count = async (table: string, extra?: [string, string]) => {
    let q = ctx.db.from(table).select('id', { count: 'exact', head: true }).eq('account_id', ctx.accountId).eq('is_sample', true)
    if (extra) q = q.eq(extra[0], extra[1])
    const { count: n, error } = await q
    return error ? 0 : (n ?? 0)
  }
  const [restaurant, events, clinic, reminders] = await Promise.all([
    count('restaurant_tables'),
    count('event_halls'),
    count('professionals'),
    count('booking_reminder_rules'),
  ])
  return { restaurant, events, clinic, reminders }
}
