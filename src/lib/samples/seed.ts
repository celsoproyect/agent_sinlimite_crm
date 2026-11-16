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

export type SampleModule = 'restaurant' | 'events' | 'clinic' | 'properties' | 'reminders' | 'instagram' | 'instagram_links'
export const SAMPLE_MODULES: SampleModule[] = ['restaurant', 'events', 'clinic', 'properties', 'reminders', 'instagram', 'instagram_links']

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
  const block = { restaurant: 1, events: 2, clinic: 3, reminders: 4, properties: 5, instagram: 6, instagram_links: 7 }[module]
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
        // A multi-row insert sends NULL, not the column default, for a key
        // only some rows carry, so every row names its status.
        status: 'waiting',
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

// ---------- real estate ----------

// Stock photos (Unsplash, free to use) so the listings look real and the
// AI's send_property_photos has something to send.
const photo = (id: string) => `https://images.unsplash.com/photo-${id}?w=1200&q=80&fm=jpg&fit=crop`

async function seedProperties(ctx: Ctx): Promise<Record<string, number | boolean>> {
  // Advisors are clinic `professionals`: each gets their own visit agenda.
  const advisors = await insertRows<{ id: string; name: string }>(ctx, 'professionals', [
    { account_id: ctx.accountId, name: 'Laura Gómez', bio: 'Asesora inmobiliaria: Santo Domingo y Santiago, ventas y alquileres.', hours: null, slot_minutes: 60, sort_order: 1, kind: 'advisor', is_sample: true },
    { account_id: ctx.accountId, name: 'Carlos Rivas', bio: 'Asesor inmobiliario: Punta Cana, Cap Cana y Bávaro, propiedades de playa.', hours: null, slot_minutes: 90, sort_order: 2, kind: 'advisor', is_sample: true },
  ])
  const [laura, carlos] = advisors
  const base = { account_id: ctx.accountId, status: 'available', is_sample: true }
  const props = await insertRows<{ id: string; title: string }>(
    ctx,
    'properties',
    [
      {
        ...base,
        code: 'EJ-101',
        title: 'Apartamento moderno en Piantini',
        operation: 'sale',
        property_type: 'apartment',
        zone: 'Piantini',
        city: 'Santo Domingo',
        address: 'Calle Gustavo Mejía Ricart, Torre Mirador, piso 9',
        price: 265000,
        currency: 'USD',
        bedrooms: 3,
        bathrooms: 3.5,
        parking: 2,
        area_m2: 185,
        amenities: ['pool', 'gym', 'elevator', 'security', 'power_plant', 'lobby', 'social_area', 'balcony', 'common_gas', 'cistern', 'service_room'],
        description:
          'Piso 9 con balcón y vista a la ciudad. Cocina abierta con isla, línea blanca de acero, cuarto de servicio con baño. Torre con piscina en la azotea, gimnasio, lobby y planta eléctrica full. A pasos de Blue Mall y Ágora.',
        photos: [
          photo('1545324418-cc1a3fa10c00'),
          photo('1560448204-e02f11c3d0e2'),
          photo('1507089947368-19c1da9775ae'),
          photo('1522708323590-d24dbb6b0267'),
          photo('1584622650111-993a426fbf0a'),
        ],
        advisor_id: laura.id,
        sort_order: 1,
      },
      {
        ...base,
        code: 'EJ-201',
        title: 'Villa con piscina privada en Cap Cana',
        operation: 'sale',
        property_type: 'villa',
        zone: 'Cap Cana',
        city: 'Punta Cana',
        address: 'Residencial Las Iguanas, Cap Cana, La Altagracia',
        price: 685000,
        currency: 'USD',
        bedrooms: 4,
        bathrooms: 4.5,
        parking: 3,
        area_m2: 420,
        amenities: ['pool', 'jacuzzi', 'gated', 'security', 'furnished', 'terrace', 'garden', 'bbq', 'air_conditioning', 'solar_panels', 'power_plant'],
        description:
          'Villa de dos niveles, se entrega amueblada y equipada. Piscina privada con jacuzzi, terraza con área de BBQ, jardín y paneles solares. Residencial cerrado con seguridad 24 horas, a 5 minutos de la playa Juanillo y del campo de golf.',
        photos: [
          photo('1613977257363-707ba9348227'),
          photo('1613490493576-7fde63acd811'),
          photo('1582268611958-ebfd161ef9cf'),
          photo('1600607687939-ce8a6c25118c'),
          photo('1540518614846-7eded433c457'),
          photo('1600573472550-8090b5e0745e'),
        ],
        advisor_id: carlos.id,
        sort_order: 2,
      },
      {
        ...base,
        code: 'EJ-301',
        title: 'Casa familiar en Los Cerros de Gurabo',
        operation: 'rent',
        property_type: 'house',
        zone: 'Los Cerros de Gurabo',
        city: 'Santiago',
        address: 'Calle 5, Los Cerros de Gurabo, Santiago de los Caballeros',
        price: 1800,
        currency: 'USD',
        bedrooms: 4,
        bathrooms: 3,
        parking: 2,
        area_m2: 300,
        amenities: ['garden', 'terrace', 'pets', 'study', 'walk_in_closet', 'appliances', 'cistern', 'air_conditioning', 'gated', 'playground'],
        description:
          'Casa de dos niveles en alquiler, sin amueblar con línea blanca incluida. Jardín amplio, terraza, estudio y walk-in closet en la principal. Acepta mascotas. Residencial cerrado con área de juegos, cerca de colegios y de la avenida 27 de Febrero.',
        photos: [
          photo('1600047509807-ba8f99d2cdde'),
          photo('1600585154340-be6161a56a0c'),
          photo('1600210492486-724fe5c67fb0'),
          photo('1505691938895-1758d7feb511'),
        ],
        advisor_id: laura.id,
        sort_order: 3,
      },
    ],
    'id, title',
  )
  const [contact] = await sampleContacts(ctx, 'properties', ['Patricia Núñez'])
  const start = at(2, '10:00')
  const { error } = await ctx.db.from('bookings').insert({
    account_id: ctx.accountId,
    contact_id: contact.id,
    kind: 'appointment',
    service: 'Visita: EJ-101 · Laura Gómez',
    starts_at: start,
    ends_at: plusMinutes(start, 60),
    status: 'confirmed',
    professional_id: laura.id,
    property_id: props[0].id,
    customer_name: contact.name,
    customer_phone: contact.phone,
    created_by: ctx.userId,
    is_sample: true,
  })
  if (error) fail(error, 'bookings')
  return { advisors: advisors.length, properties: props.length, bookings: 1 }
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

// ---------- instagram (migration 080) ----------

/** A one-page PDF ("Catálogo de ejemplo"), built by hand so no library is needed. */
export function samplePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '').replace(/([\\()])/g, '\\$1')
  const text = lines.map((l, i) => `BT /F1 ${i === 0 ? 22 : 13} Tf 60 ${740 - i * 30} Td (${esc(l)}) Tj ET`).join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

async function findOrCreateTag(ctx: Ctx, name: string, color: string): Promise<string | null> {
  const { data } = await ctx.db.from('tags').select('id, name').eq('account_id', ctx.accountId)
  const found = ((data ?? []) as { id: string; name: string }[]).find((t) => t.name.trim().toLowerCase() === name.toLowerCase())
  if (found) return found.id
  const { data: created } = await ctx.db
    .from('tags')
    .insert({ account_id: ctx.accountId, user_id: ctx.userId, name, color })
    .select('id')
    .maybeSingle()
  return (created as { id: string } | null)?.id ?? null
}

/** The first pipeline and its first open stage, for the "hot lead" deal. */
async function firstOpenStage(ctx: Ctx): Promise<{ pipeline_id: string; stage_id: string } | null> {
  const { data: pipes } = await ctx.db.from('pipelines').select('id').eq('account_id', ctx.accountId).order('created_at').limit(1)
  const pipelineId = (pipes as { id: string }[] | null)?.[0]?.id
  if (!pipelineId) return null
  const { data: stages } = await ctx.db.from('pipeline_stages').select('*').eq('pipeline_id', pipelineId).order('position')
  const stage = ((stages ?? []) as { id: string; kind?: string | null }[]).find((s) => !s.kind || s.kind === 'open')
  return stage ? { pipeline_id: pipelineId, stage_id: stage.id } : null
}

function failInstagram(error: { code?: string; message: string } | null, what: string): never {
  if (error?.code && MISSING.has(error.code)) {
    throw new SampleError('Run migration 080 first.', 'needs_migration', 503)
  }
  fail(error, what)
}

async function insertAutomation(
  ctx: Ctx,
  row: { name: string; description: string; trigger_type: string; trigger_config: Record<string, unknown> },
  steps: { step_type: string; step_config: Record<string, unknown> }[],
): Promise<string> {
  const { data, error } = await ctx.db
    .from('automations')
    .insert({ ...row, account_id: ctx.accountId, user_id: ctx.userId, is_active: true, is_sample: true })
    .select('id')
    .single()
  if (error || !data) failInstagram(error, 'automations')
  const id = (data as { id: string }).id
  if (steps.length) {
    const { error: stepErr } = await ctx.db
      .from('automation_steps')
      .insert(steps.map((s, position) => ({ ...s, automation_id: id, position })))
    if (stepErr) failInstagram(stepErr, 'automation_steps')
  }
  return id
}

/**
 * One example of every kind of comment rule, plus the lead-qualifying
 * automations the "automation" example starts. The rules are created
 * switched off: this is a live Instagram account, so nothing answers a
 * real comment until the owner turns an example on.
 */
async function seedInstagram(ctx: Ctx): Promise<Record<string, number | boolean>> {
  // Probe the 080 columns first, so a missing migration says so clearly.
  const probe = await ctx.db.from('instagram_keyword_rules').select('media_ids, is_sample', { head: true }).eq('account_id', ctx.accountId)
  if (probe.error) failInstagram(probe.error, 'instagram_keyword_rules')

  const { data: postRows } = await ctx.db
    .from('instagram_posts')
    .select('media_id')
    .eq('account_id', ctx.accountId)
    .order('posted_at', { ascending: false })
    .limit(4)
  const posts = ((postRows ?? []) as { media_id: string }[]).map((p) => p.media_id)

  const { data: items } = await ctx.db.from('ai_attachments').select('id').eq('account_id', ctx.accountId).order('updated_at', { ascending: false }).limit(1)
  const catalogId = (items as { id: string }[] | null)?.[0]?.id ?? null

  // The example PDF goes to the account's chat-media folder.
  let pdfUrl: string | null = null
  const pdfPath = `account-${ctx.accountId}/${Date.now()}-catalogo-ejemplo.pdf`
  const upload = await ctx.db.storage.from('chat-media').upload(
    pdfPath,
    samplePdf([
      'Catalogo de ejemplo',
      'Este PDF lo envia la regla "Ejemplo: enviar PDF".',
      'Cambialo por tu catalogo, menu o lista de precios',
      'en Instagram > Palabras clave > Editar regla > Archivo.',
    ]),
    { contentType: 'application/pdf' },
  )
  if (!upload.error) pdfUrl = ctx.db.storage.from('chat-media').getPublicUrl(pdfPath).data.publicUrl

  const [igTag, hotTag, coldTag, stage] = await Promise.all([
    findOrCreateTag(ctx, 'Lead Instagram', '#d946ef'),
    findOrCreateTag(ctx, 'Lead caliente', '#ef4444'),
    findOrCreateTag(ctx, 'Lead frío', '#3b82f6'),
    firstOpenStage(ctx),
  ])

  // 1) The rule starts this one: ask when they need it, tag the lead.
  const qualifyId = await insertAutomation(
    ctx,
    {
      name: 'Instagram: calificar lead (ejemplo)',
      description: 'La inicia la regla "Ejemplo: calificar con automatización" cuando el cliente toca el botón.',
      trigger_type: 'instagram_rule',
      trigger_config: {},
    },
    [
      ...(igTag ? [{ step_type: 'add_tag', step_config: { tag_id: igTag } }] : []),
      {
        step_type: 'send_buttons',
        step_config: {
          kind: 'buttons',
          body: 'Para darte la mejor información, ¿para cuándo lo necesitas?',
          buttons: [
            { id: 'IGQ_NOW', title: 'Esta semana' },
            { id: 'IGQ_MONTH', title: 'Este mes' },
            { id: 'IGQ_LATER', title: 'Solo mirando' },
          ],
        },
      },
    ],
  )
  // 2) The answers: soon = hot lead (tag, deal, a person follows up).
  await insertAutomation(
    ctx,
    {
      name: 'Instagram: lead caliente (ejemplo)',
      description: 'Responde "Esta semana" o "Este mes": etiqueta Lead caliente y crea la oportunidad.',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids: ['IGQ_NOW', 'IGQ_MONTH'] },
    },
    [
      ...(hotTag ? [{ step_type: 'add_tag', step_config: { tag_id: hotTag } }] : []),
      ...(stage ? [{ step_type: 'create_deal', step_config: { ...stage, title: 'Lead de Instagram', value: 0 } }] : []),
      { step_type: 'send_message', step_config: { text: '¡Perfecto! 🙌 Un asesor te escribirá en breve para ayudarte.' } },
    ],
  )
  // 3) "Just looking" = cold lead: tag it and leave the door open.
  await insertAutomation(
    ctx,
    {
      name: 'Instagram: lead frío (ejemplo)',
      description: 'Responde "Solo mirando": etiqueta Lead frío.',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids: ['IGQ_LATER'] },
    },
    [
      ...(coldTag ? [{ step_type: 'add_tag', step_config: { tag_id: coldTag } }] : []),
      { step_type: 'send_message', step_config: { text: '¡Sin problema! 😊 Aquí estamos cuando lo necesites. Escríbenos por aquí.' } },
    ],
  )

  const replies = ['¡Listo {{username}}! Te escribí por mensaje privado 📩', 'Gracias {{username}}, revisa tus mensajes 💬']
  const base = {
    account_id: ctx.accountId,
    match_any: false,
    public_replies: replies,
    dm_opening: null as string | null,
    dm_button_label: null as string | null,
    dm_text: '',
    dm_link_url: null as string | null,
    catalog_item_id: null as string | null,
    tag_id: igTag,
    dm_media_url: null as string | null,
    dm_media_kind: null as string | null,
    dm_media_name: null as string | null,
    automation_id: null as string | null,
    once_per_user: true,
    active: false,
    is_sample: true,
  }
  const on = (ids: string[]) => ({ media_ids: ids, media_id: ids[0] ?? null })
  const first = posts.slice(0, 1)
  const rules: Record<string, unknown>[] = [
    {
      ...base,
      ...on(first),
      name: 'Ejemplo: palabra clave en una publicación',
      keywords: ['PRECIO'],
      dm_opening: '¡Hola! 👋 Gracias por comentar. Toca el botón y te envío los precios.',
      dm_button_label: '🟢 Ver precios',
      dm_text: 'Estos son nuestros precios:\n• Servicio básico: RD$1,000\n• Servicio completo: RD$2,500\n\n¿Te gustaría agendar?',
    },
    {
      ...base,
      ...on([]),
      name: 'Ejemplo: palabra clave en todas las publicaciones',
      keywords: ['INFO', 'INFORMACION'],
      dm_button_label: '🔵 Recibir información',
      dm_text: '¡Hola! Aquí tienes la información que pediste. Si tienes dudas, escríbeme por aquí.',
    },
    {
      ...base,
      ...on(posts.slice(1, 2).length ? posts.slice(1, 2) : first),
      name: 'Ejemplo: cualquier comentario en una publicación',
      keywords: [],
      match_any: true,
      dm_text: '¡Gracias por comentar! 😊 Si quieres más detalles de esta publicación, respóndeme por aquí.',
    },
    {
      ...base,
      ...on([]),
      name: 'Ejemplo: cualquier comentario (todas las publicaciones)',
      keywords: [],
      match_any: true,
      public_replies: ['¡Gracias {{username}}! 💛'],
      dm_text: '',
      tag_id: null,
    },
    {
      ...base,
      ...on([]),
      name: 'Ejemplo: texto y enlace directo (sin botón)',
      keywords: ['WEB', 'LINK'],
      dm_text: 'Aquí tienes nuestro enlace 👇',
      dm_link_url: 'https://example.com',
    },
    {
      ...base,
      ...on(posts),
      name: `Ejemplo: una regla para ${posts.length > 1 ? `${posts.length} publicaciones` : 'varias publicaciones'}`,
      keywords: ['DETALLES'],
      dm_button_label: '🟡 Ver detalles',
      dm_text: 'Estos detalles aplican a todas las publicaciones de esta regla. Agrega o quita publicaciones al editarla.',
    },
    {
      ...base,
      ...on([]),
      name: 'Ejemplo: calificar con automatización',
      keywords: ['QUIERO'],
      dm_opening: '¡Hola! 👋 Te hago 1 pregunta rápida para ayudarte mejor.',
      dm_button_label: '🟣 Empezar',
      automation_id: qualifyId,
    },
  ]
  if (pdfUrl) {
    rules.push({
      ...base,
      ...on([]),
      name: 'Ejemplo: enviar PDF',
      keywords: ['CATALOGO', 'PDF'],
      dm_opening: '¡Hola! 📄 Toca el botón y te envío el catálogo en PDF.',
      dm_button_label: '🔴 Recibir catálogo',
      dm_text: 'Aquí tienes el catálogo. ¿Te interesa algo en especial?',
      dm_media_url: pdfUrl,
      dm_media_kind: 'document',
      dm_media_name: 'catalogo-ejemplo.pdf',
    })
  }
  if (catalogId) {
    rules.push({
      ...base,
      ...on([]),
      name: 'Ejemplo: enviar un producto del catálogo',
      keywords: ['PRODUCTO'],
      dm_opening: '¡Hola! Toca el botón y te envío la foto y los detalles.',
      dm_button_label: '🟠 Ver producto',
      catalog_item_id: catalogId,
    })
  }
  const { error } = await ctx.db.from('instagram_keyword_rules').insert(rules)
  if (error) failInstagram(error, 'instagram_keyword_rules')
  return { rules: rules.length, automations: 3, posts: posts.length, pdf: !!pdfUrl, catalog: !!catalogId }
}

// ---------- removal ----------

// ---------- instagram campaign links (migration 083) ----------

/**
 * Three campaign links, active, so the owner can open them from another
 * Instagram account and see each action: a welcome message with a tag
 * (QR on the counter), the AI with the campaign's context (bio link),
 * and the lead-qualifying automation of the Instagram examples (promo).
 */
async function seedInstagramLinks(ctx: Ctx): Promise<Record<string, number | boolean>> {
  const probe = await ctx.db.from('instagram_links').select('id', { head: true }).eq('account_id', ctx.accountId)
  if (probe.error) {
    if (MISSING.has(probe.error.code ?? '')) throw new SampleError('Run migration 083 first.', 'needs_migration', 503)
    fail(probe.error, 'instagram_links')
  }
  // Real links keep their codes: an example only takes a free one.
  const { data: existing } = await ctx.db.from('instagram_links').select('code').eq('account_id', ctx.accountId)
  const taken = new Set(((existing ?? []) as { code: string }[]).map((l) => l.code.toLowerCase()))
  const free = (code: string) => (taken.has(code.toLowerCase()) ? `${code}_EJ` : code)

  const [qrTag, promoTag] = await Promise.all([
    findOrCreateTag(ctx, 'Campaña QR', '#0ea5e9'),
    findOrCreateTag(ctx, 'Promo Instagram', '#f59e0b'),
  ])
  const { data: autos } = await ctx.db
    .from('automations')
    .select('id, name')
    .eq('account_id', ctx.accountId)
    .eq('trigger_type', 'instagram_rule')
    .order('created_at', { ascending: false })
  const qualify = ((autos ?? []) as { id: string; name: string }[]).find((a) => /calificar lead/i.test(a.name))

  const rows = [
    {
      name: 'Ejemplo: QR del mostrador',
      code: free('QR_LOCAL'),
      action: 'message',
      welcome_text:
        '¡Hola! 👋 Gracias por escanear nuestro QR. Por venir de la tienda tienes *10% de descuento* en tu primera compra.\n\nCuéntame qué estás buscando y te ayudo.',
      ai_context: 'Llegó escaneando el QR del mostrador de la tienda. Tiene 10% de descuento en su primera compra.',
      tag_id: qrTag,
    },
    {
      name: 'Ejemplo: enlace de la bio',
      code: free('BIO'),
      action: 'ai',
      welcome_text: null,
      ai_context:
        'Llegó desde el enlace de la biografía de Instagram. Salúdalo, pregúntale qué le interesa y muéstrale lo que tenemos.',
      tag_id: null,
    },
    qualify
      ? {
          name: 'Ejemplo: promo con calificación',
          code: free('PROMO'),
          action: 'automation',
          welcome_text: '¡Hola! 🎉 Viste nuestra promo. Te hago una pregunta rápida para darte la mejor oferta.',
          ai_context: 'Llegó por el enlace de la promo publicada en Instagram.',
          automation_id: qualify.id,
          tag_id: promoTag,
        }
      : {
          name: 'Ejemplo: promo',
          code: free('PROMO'),
          action: 'message',
          welcome_text: '¡Hola! 🎉 Viste nuestra promo. ¿Quieres que te cuente los detalles?',
          ai_context: 'Llegó por el enlace de la promo publicada en Instagram.',
          tag_id: promoTag,
        },
  ]
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'
  const slug = () => Array.from({ length: 8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')
  const { error } = await ctx.db
    .from('instagram_links')
    .insert(rows.map((r) => ({ ...r, account_id: ctx.accountId, slug: slug(), active: true, is_sample: true })))
  if (error) fail(error, 'instagram_links')
  return { links: rows.length, automation: !!qualify }
}

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
  if (module === 'instagram') {
    // Rules first (they point at the automations); steps cascade.
    await del(ctx, 'instagram_keyword_rules')
    await del(ctx, 'automations')
    return
  }
  if (module === 'instagram_links') {
    await del(ctx, 'instagram_links')
    return
  }
  if (module === 'properties') {
    // Example visits, listings, then the advisors those listings named.
    const advisorIds = await sampleAdvisorIds(ctx)
    await del(ctx, 'bookings', (q) => q.not('property_id', 'is', null))
    await del(ctx, 'properties')
    if (advisorIds.length) await del(ctx, 'professionals', (q) => q.in('id', advisorIds))
    await removeOrphanSampleContacts(ctx)
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
    // The real estate example advisors are professionals too; they go
    // with the property examples, not with the clinic's.
    const advisorIds = await sampleAdvisorIds(ctx)
    await del(ctx, 'professionals', advisorIds.length ? (q) => q.not('id', 'in', `(${advisorIds.join(',')})`) : undefined)
    await del(ctx, 'specialties')
  }
  await removeOrphanSampleContacts(ctx)
}

/** The advisors named by example listings ([] before migration 077). */
async function sampleAdvisorIds(ctx: Ctx): Promise<string[]> {
  const { data, error } = await ctx.db.from('properties').select('advisor_id').eq('account_id', ctx.accountId).eq('is_sample', true)
  if (error) return []
  return [...new Set(((data ?? []) as { advisor_id: string | null }[]).map((p) => p.advisor_id).filter((id): id is string => !!id))]
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
    case 'properties':
      return seedProperties(ctx)
    case 'reminders':
      return seedReminders(ctx, scope)
    case 'instagram':
      return seedInstagram(ctx)
    case 'instagram_links':
      return seedInstagramLinks(ctx)
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
  const [restaurant, events, clinic, properties, reminders, instagram, instagram_links] = await Promise.all([
    count('restaurant_tables'),
    count('event_halls'),
    count('professionals'),
    count('properties'),
    count('booking_reminder_rules'),
    count('instagram_keyword_rules'),
    count('instagram_links'),
  ])
  return { restaurant, events, clinic, properties, reminders, instagram, instagram_links }
}
