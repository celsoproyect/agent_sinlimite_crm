import { amenityMentioned, canonicalAmenities, canonicalAmenity, normalizeText } from './amenities'

// ============================================================
// Real estate module: the property search behind the AI's
// `search_properties` tool. Pure, so the ranking is unit-tested.
//
// Hard filters: operation, type, zone, budget, bedrooms, bathrooms,
// parking. Amenities are soft: properties with every requested amenity
// come first, then the ones that miss some (each result says which it
// has and which it lacks), so the agent can offer the closest options
// instead of answering "nothing found".
// ============================================================

export const PROPERTY_OPERATIONS = ['sale', 'rent'] as const
export type PropertyOperation = (typeof PROPERTY_OPERATIONS)[number]

export const PROPERTY_TYPES = [
  'apartment',
  'house',
  'villa',
  'penthouse',
  'land',
  'commercial',
  'office',
  'warehouse',
  'room',
] as const
export type PropertyType = (typeof PROPERTY_TYPES)[number]

export const PROPERTY_STATUSES = ['available', 'reserved', 'sold', 'rented'] as const
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number]

export interface Property {
  id: string
  account_id: string
  code: string | null
  title: string
  operation: PropertyOperation
  property_type: PropertyType
  zone: string | null
  city: string | null
  address: string | null
  price: number | null
  currency: string
  bedrooms: number | null
  bathrooms: number | null
  parking: number | null
  area_m2: number | null
  amenities: string[]
  description: string | null
  photos: string[]
  status: PropertyStatus
  advisor_id: string | null
  active: boolean
  sort_order: number
  is_sample?: boolean
  created_at: string
  updated_at: string
}

export interface PropertySearchArgs {
  operation?: PropertyOperation
  propertyType?: PropertyType
  zone?: string
  minPrice?: number
  maxPrice?: number
  minBedrooms?: number
  minBathrooms?: number
  minParking?: number
  minArea?: number
  amenities?: string[]
  /** Free words: matched against the title, code, zone, address and description. */
  query?: string
}

export interface PropertyMatch {
  property: Property
  matchedAmenities: string[]
  missingAmenities: string[]
}

// What customers call each type ("apto", "casa", "solar"…).
const TYPE_WORDS: Record<PropertyType, string[]> = {
  apartment: ['apartment', 'apartamento', 'apartamentos', 'apto', 'aptos', 'depto', 'departamento', 'condo', 'flat'],
  house: ['house', 'casa', 'casas', 'home'],
  villa: ['villa', 'villas', 'quinta'],
  penthouse: ['penthouse', 'ph', 'pent house'],
  land: ['land', 'solar', 'solares', 'terreno', 'terrenos', 'lote', 'lotes', 'finca'],
  commercial: ['commercial', 'local', 'local comercial', 'locales', 'comercial'],
  office: ['office', 'oficina', 'oficinas'],
  warehouse: ['warehouse', 'nave', 'nave industrial', 'almacen', 'galpon', 'bodega'],
  room: ['room', 'habitacion', 'cuarto', 'estudio amueblado'],
}

export function parsePropertyType(raw: unknown): PropertyType | undefined {
  if (typeof raw !== 'string') return undefined
  const text = normalizeText(raw)
  if (!text) return undefined
  for (const type of PROPERTY_TYPES) {
    if (type === text || TYPE_WORDS[type].includes(text)) return type
  }
  return undefined
}

export function parseOperation(raw: unknown): PropertyOperation | undefined {
  if (typeof raw !== 'string') return undefined
  const text = normalizeText(raw)
  if (['sale', 'venta', 'vender', 'comprar', 'compra', 'buy'].includes(text)) return 'sale'
  if (['rent', 'renta', 'alquiler', 'alquilar', 'rentar', 'arriendo', 'lease'].includes(text)) return 'rent'
  return undefined
}

/** Whether `zone` (as the customer said it) matches the property's zone/city/address. */
export function zoneMatches(property: Pick<Property, 'zone' | 'city' | 'address'>, zone: string): boolean {
  const wanted = normalizeText(zone)
  if (!wanted) return true
  const haystack = normalizeText([property.zone, property.city, property.address].filter(Boolean).join(' | '))
  if (!haystack) return false
  if (haystack.includes(wanted)) return true
  // "Piantini, Santo Domingo" → every meaningful word must be there.
  const words = wanted.split(' ').filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  return words.length > 0 && words.every((w) => haystack.includes(w))
}

const STOP_WORDS = new Set(['del', 'las', 'los', 'por', 'con', 'una', 'uno', 'que', 'the', 'and', 'zona', 'sector', 'area'])

function queryMatches(property: Property, query: string): boolean {
  const words = normalizeText(query)
    .split(' ')
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  if (words.length === 0) return true
  const haystack = normalizeText(
    [property.title, property.code, property.zone, property.city, property.address, property.description].filter(Boolean).join(' '),
  )
  return words.some((w) => haystack.includes(w))
}

/** Which of `wanted` (canonical) a property offers. A free-text request
 *  also matches when its words appear in the description. */
export function amenityCoverage(property: Property, wanted: string[]): { matched: string[]; missing: string[] } {
  const have = new Set(property.amenities.map((a) => canonicalAmenity(a) ?? a))
  const description = `${property.description ?? ''} ${property.title}`
  const matched: string[] = []
  const missing: string[] = []
  for (const a of wanted) {
    if (have.has(a) || amenityMentioned(description, a)) {
      matched.push(a)
    } else {
      missing.push(a)
    }
  }
  return { matched, missing }
}

/**
 * Available, active properties that pass the hard filters, best first:
 * all requested amenities, then the most of them, then the closest to
 * the budget (cheapest first when there's no budget), then sort order.
 */
export function searchProperties(properties: Property[], args: PropertySearchArgs, limit = 5): PropertyMatch[] {
  const wanted = canonicalAmenities(args.amenities ?? [])
  const matches: PropertyMatch[] = []
  for (const p of properties) {
    if (!p.active || p.status !== 'available') continue
    if (args.operation && p.operation !== args.operation) continue
    if (args.propertyType && p.property_type !== args.propertyType) continue
    if (args.zone && !zoneMatches(p, args.zone)) continue
    if (args.maxPrice != null && (p.price == null || p.price > args.maxPrice)) continue
    if (args.minPrice != null && p.price != null && p.price < args.minPrice) continue
    if (args.minBedrooms != null && (p.bedrooms ?? 0) < args.minBedrooms) continue
    if (args.minBathrooms != null && (p.bathrooms ?? 0) < args.minBathrooms) continue
    if (args.minParking != null && (p.parking ?? 0) < args.minParking) continue
    if (args.minArea != null && (p.area_m2 ?? 0) < args.minArea) continue
    if (args.query && !queryMatches(p, args.query)) continue
    const { matched, missing } = amenityCoverage(p, wanted)
    matches.push({ property: p, matchedAmenities: matched, missingAmenities: missing })
  }
  // Amenities asked for: a property with none of them is no answer,
  // unless nothing has any (then the agent says so and offers these).
  const filtered =
    wanted.length > 0 && matches.some((m) => m.matchedAmenities.length > 0)
      ? matches.filter((m) => m.matchedAmenities.length > 0)
      : matches
  filtered.sort((a, b) => {
    const fullA = a.missingAmenities.length === 0 ? 0 : 1
    const fullB = b.missingAmenities.length === 0 ? 0 : 1
    if (fullA !== fullB) return fullA - fullB
    if (a.matchedAmenities.length !== b.matchedAmenities.length) return b.matchedAmenities.length - a.matchedAmenities.length
    const pa = a.property.price ?? Number.MAX_SAFE_INTEGER
    const pb = b.property.price ?? Number.MAX_SAFE_INTEGER
    if (args.maxPrice != null) {
      // Closest to the budget first: the customer can afford all of them.
      if (pa !== pb) return pb - pa
    } else if (pa !== pb) {
      return pa - pb
    }
    return a.property.sort_order - b.property.sort_order
  })
  return filtered.slice(0, Math.max(1, limit))
}
