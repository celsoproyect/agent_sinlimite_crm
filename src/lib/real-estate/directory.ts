import type { SupabaseClient } from '@supabase/supabase-js'
import { accountModuleEnabled } from '@/lib/modules-server'
import { preferReal } from '@/lib/samples/prefer-real'
import { amenityLabel, normalizeText } from './amenities'
import { searchProperties, type Property, type PropertyMatch, type PropertySearchArgs, type PropertyType } from './search'

// ============================================================
// Real estate module (migration 077) for the AI: the inventory the
// agent searches, the prompt summary and the tool results.
// ============================================================

export interface PropertyDirectory {
  properties: Property[]
  /** professional id → name: the advisors who show the properties. */
  advisors: Map<string, string>
}

export function isMissingPropertiesSchema(code: string | undefined): boolean {
  return code === '42P01' || code === '42703' || code === 'PGRST200' || code === 'PGRST205'
}

/** Numeric columns come back from PostgREST as strings. */
export function toProperty(row: Record<string, unknown>): Property {
  const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))
  return {
    ...(row as unknown as Property),
    price: num(row.price),
    bedrooms: num(row.bedrooms),
    bathrooms: num(row.bathrooms),
    parking: num(row.parking),
    area_m2: num(row.area_m2),
    amenities: Array.isArray(row.amenities) ? (row.amenities as string[]) : [],
    photos: Array.isArray(row.photos) ? (row.photos as string[]) : [],
  }
}

/** The available inventory, or null while the module is off, the
 *  migration hasn't run, or nothing is listed. */
export async function getPropertyDirectory(db: SupabaseClient, accountId: string): Promise<PropertyDirectory | null> {
  try {
    if (!(await accountModuleEnabled(db, accountId, 'properties'))) return null
    const [propsRes, advisorsRes] = await Promise.all([
      db
        .from('properties')
        .select('*')
        .eq('account_id', accountId)
        .eq('active', true)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: false })
        .limit(1000),
      db.from('professionals').select('id, name').eq('account_id', accountId).eq('active', true),
    ])
    if (propsRes.error) {
      if (!isMissingPropertiesSchema(propsRes.error.code)) console.error('[properties] load failed:', propsRes.error)
      return null
    }
    const properties = preferReal((propsRes.data ?? []).map((r) => toProperty(r as Record<string, unknown>)))
    if (properties.length === 0) return null
    const advisors = new Map(((advisorsRes.data ?? []) as { id: string; name: string }[]).map((a) => [a.id, a.name]))
    return { properties, advisors }
  } catch (err) {
    console.error('[properties] load threw:', err)
    return null
  }
}

const TYPE_LABEL: Record<PropertyType, string> = {
  apartment: 'apartment',
  house: 'house',
  villa: 'villa',
  penthouse: 'penthouse',
  land: 'land/lot',
  commercial: 'commercial space',
  office: 'office',
  warehouse: 'warehouse',
  room: 'room',
}

function countBy(values: (string | null)[]): string[] {
  const counts = new Map<string, number>()
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} (${n})`)
}

/** A short summary for the system prompt: what kinds of listings exist
 *  and where, never the listings themselves (the tool searches them). */
export function formatPropertyRoster(dir: PropertyDirectory): string {
  const available = dir.properties.filter((p) => p.status === 'available')
  const sale = available.filter((p) => p.operation === 'sale').length
  const rent = available.length - sale
  const types = countBy(available.map((p) => TYPE_LABEL[p.property_type]))
  const zones = countBy(available.map((p) => p.zone || p.city)).slice(0, 25)
  const amenities = countBy(available.flatMap((p) => p.amenities.map((a) => amenityLabel(a)))).slice(0, 30)
  return [
    `${available.length} available listings: ${sale} for sale, ${rent} for rent.`,
    types.length ? `Types: ${types.join(', ')}.` : '',
    zones.length ? `Zones: ${zones.join(', ')}.` : '',
    amenities.length ? `Amenities found in the listings: ${amenities.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

function money(price: number | null, currency: string): string | null {
  if (price == null) return null
  return `${currency} ${price.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

/** One match as the model sees it. */
export function propertyMatchForModel(m: PropertyMatch, dir: PropertyDirectory) {
  const p = m.property
  return {
    property_id: p.id,
    ...(p.code ? { code: p.code } : {}),
    title: p.title,
    operation: p.operation === 'sale' ? 'for sale' : 'for rent',
    type: TYPE_LABEL[p.property_type],
    zone: [p.zone, p.city].filter(Boolean).join(', ') || null,
    price: money(p.price, p.currency) ?? 'ask the team',
    ...(p.operation === 'rent' && p.price != null ? { price_period: 'per month' } : {}),
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    parking: p.parking,
    area_m2: p.area_m2,
    amenities: p.amenities.map((a) => amenityLabel(a)),
    ...(m.matchedAmenities.length || m.missingAmenities.length
      ? {
          has_requested: m.matchedAmenities.map((a) => amenityLabel(a)),
          lacks_requested: m.missingAmenities.map((a) => amenityLabel(a)),
        }
      : {}),
    description: p.description ? p.description.slice(0, 400) : null,
    photos: p.photos.length,
    ...(p.advisor_id && dir.advisors.has(p.advisor_id)
      ? { advisor: dir.advisors.get(p.advisor_id), advisor_professional_id: p.advisor_id }
      : {}),
  }
}

/** Run a search and build the tool result. */
export function runPropertySearch(dir: PropertyDirectory, args: PropertySearchArgs): string {
  const matches = searchProperties(dir.properties, args, 5)
  if (matches.length === 0) {
    // Nothing passes every filter: before saying "we have nothing", look
    // for listings in the same zone (and type) that miss on the rest, and
    // tell the model exactly how each one differs. Customers' earlier
    // criteria (rent vs buy, rooms, budget) often linger in the search.
    const near = nearMatches(dir.properties, args)
    if (near.length > 0) {
      return JSON.stringify({
        count: 0,
        closest: near.map((m) => ({ ...propertyMatchForModel(m, dir), differs: differences(m.property, args) })),
        note: 'Nothing matches every criterion, but these are close. Never say there is nothing in that zone: present them, saying plainly how each differs (the "differs" list), and ask whether they want to see it.',
      })
    }
  }
  const wantedAmenities = (args.amenities ?? []).length > 0
  const full = matches.filter((m) => m.missingAmenities.length === 0).length
  const note =
    matches.length === 0
      ? 'Nothing matches. Say so, and offer to widen the search (another zone, a higher budget, fewer rooms) or to have an advisor look for options.'
      : wantedAmenities && full === 0
        ? 'None has every amenity requested. Say so plainly, then offer these as the closest options, saying for each which requested amenities it has and which it lacks.'
        : wantedAmenities && full < matches.length
          ? `The first ${full} have every requested amenity; the rest are close options: say which amenities each one lacks.`
          : 'Present them briefly (title, code, zone, price, rooms and the amenities that matter to the customer) and ask which one interests them.'
  return JSON.stringify({ count: matches.length, properties: matches.map((m) => propertyMatchForModel(m, dir)), note })
}

/** Listings that keep the zone (then the type) but drop the other filters. */
export function nearMatches(properties: Property[], args: PropertySearchArgs, limit = 3): PropertyMatch[] {
  const tries: PropertySearchArgs[] = []
  if (args.zone && args.propertyType) tries.push({ zone: args.zone, propertyType: args.propertyType, amenities: args.amenities })
  if (args.zone) tries.push({ zone: args.zone, amenities: args.amenities })
  else if (args.propertyType) tries.push({ propertyType: args.propertyType, operation: args.operation, amenities: args.amenities })
  for (const t of tries) {
    const found = searchProperties(properties, t, limit)
    if (found.length > 0) return found
  }
  return []
}

/** How a listing misses the customer's hard criteria, in words for the model. */
export function differences(p: Property, args: PropertySearchArgs): string[] {
  const out: string[] = []
  if (args.operation && p.operation !== args.operation) out.push(p.operation === 'sale' ? 'it is for sale, not for rent' : 'it is for rent, not for sale')
  if (args.propertyType && p.property_type !== args.propertyType) out.push(`it is a ${TYPE_LABEL[p.property_type]}, not a ${TYPE_LABEL[args.propertyType]}`)
  if (args.maxPrice != null && p.price != null && p.price > args.maxPrice) out.push(`it costs ${money(p.price, p.currency)}, above the budget`)
  if (args.minPrice != null && p.price != null && p.price < args.minPrice) out.push(`it costs ${money(p.price, p.currency)}, below the minimum`)
  if (args.minBedrooms != null && (p.bedrooms ?? 0) < args.minBedrooms) out.push(`${p.bedrooms ?? 0} bedrooms, fewer than asked`)
  if (args.minBathrooms != null && (p.bathrooms ?? 0) < args.minBathrooms) out.push(`${p.bathrooms ?? 0} bathrooms, fewer than asked`)
  if (args.minParking != null && (p.parking ?? 0) < args.minParking) out.push(`${p.parking ?? 0} parking spaces, fewer than asked`)
  if (args.minArea != null && (p.area_m2 ?? 0) < args.minArea) out.push(`${p.area_m2 ?? 0} m², smaller than asked`)
  return out
}

/**
 * The listing the model means: its property_id, its code or its title.
 * The model only keeps the text of earlier turns (not the tool results),
 * so a turn later it knows "Casa familiar en Los Cerros de Gurabo" but
 * not its id.
 */
export function findProperty(properties: Property[], ref: string): Property | null {
  const raw = ref.trim()
  if (!raw) return null
  const byId = properties.find((p) => p.id === raw)
  if (byId) return byId
  const wanted = normalizeText(raw.replace(/^\*+|\*+$/g, ''))
  if (!wanted) return null
  const byCode = properties.find((p) => p.code && normalizeText(p.code) === wanted)
  if (byCode) return byCode
  const byTitle = properties.filter((p) => normalizeText(p.title) === wanted)
  if (byTitle.length === 1) return byTitle[0]
  const contains = properties.filter((p) => {
    const t = normalizeText(p.title)
    return t.includes(wanted) || wanted.includes(t) || (p.code ? wanted.includes(normalizeText(p.code)) : false)
  })
  if (contains.length === 1) return contains[0]
  // Best word overlap, only when one listing clearly wins.
  const words = wanted.split(' ').filter((w) => w.length > 2)
  if (words.length === 0) return null
  const scored = properties
    .map((p) => {
      const hay = normalizeText([p.title, p.zone, p.city].filter(Boolean).join(' '))
      return { p, score: words.filter((w) => hay.includes(w)).length }
    })
    .sort((a, b) => b.score - a.score)
  if (scored[0] && scored[0].score >= Math.min(2, words.length) && scored[0].score > (scored[1]?.score ?? 0)) return scored[0].p
  return null
}
