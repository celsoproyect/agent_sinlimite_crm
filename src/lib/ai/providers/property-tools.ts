import { canonicalAmenities } from '@/lib/real-estate/amenities'
import { parseOperation, parsePropertyType, PROPERTY_TYPES, type PropertySearchArgs } from '@/lib/real-estate/search'

// ============================================================
// Real estate tools (migration 077), shared by both adapters through
// `venueToolDefinitions` / `runVenueTool`.
// ============================================================

export const SEARCH_PROPERTIES_TOOL_NAME = 'search_properties'
export const SEND_PROPERTY_PHOTOS_TOOL_NAME = 'send_property_photos'

export interface RealEstateToolExec {
  search: (args: PropertySearchArgs) => Promise<string>
  /** Queues a property's photos to go out before the reply. Absent where
   *  the channel can't send images (web widget) or nothing is sent
   *  (Playground, inbox draft). */
  sendPhotos?: (propertyId: string) => Promise<{ sent: number; error?: string }>
}

interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export function propertyToolDefinitions(exec: RealEstateToolExec): ToolDef[] {
  const defs: ToolDef[] = [
    {
      name: SEARCH_PROPERTIES_TOOL_NAME,
      description:
        "Search the business's property listings (only available ones). Pass every criterion the customer gave: operation (buy or rent), type, zone, budget, minimum bedrooms/bathrooms/parking, and EVERY amenity they asked for (pool, gym, elevator, 24h security, backup power, balcony, pets allowed, furnished…). Amenities are ranked, not required: results with all of them come first, and each result says which requested amenities it has and lacks.",
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: ['sale', 'rent'], description: 'Optional. sale = to buy, rent = to rent.' },
          property_type: { type: 'string', enum: [...PROPERTY_TYPES], description: 'Optional.' },
          zone: { type: 'string', description: 'Optional. Neighborhood, sector or city, as the customer said it.' },
          min_price: { type: 'number', description: 'Optional. Minimum price.' },
          max_price: { type: 'number', description: 'Optional. The customer\'s budget (maximum price; monthly rent for rentals).' },
          min_bedrooms: { type: 'integer', description: 'Optional.' },
          min_bathrooms: { type: 'number', description: 'Optional.' },
          min_parking: { type: 'integer', description: 'Optional. Parking spaces.' },
          min_area_m2: { type: 'number', description: 'Optional. Minimum size in square meters.' },
          amenities: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional. Every amenity the customer asked for, each as a short phrase in their words (e.g. ["piscina", "gimnasio", "planta eléctrica"]).',
          },
          query: { type: 'string', description: 'Optional. A property code or other words to look for (title, address, description).' },
        },
      },
    },
  ]
  if (exec.sendPhotos) {
    defs.push({
      name: SEND_PROPERTY_PHOTOS_TOOL_NAME,
      description:
        'Send the photos of one property to the customer (they arrive before your text). Use it when they ask for photos or show interest in a specific property.',
      parameters: {
        type: 'object',
        properties: { property_id: { type: 'string', description: 'The property_id from search_properties.' } },
        required: ['property_id'],
      },
    })
  }
  return defs
}

type Args = Record<string, unknown>

function num(args: Args, key: string): number | undefined {
  const v = args[key]
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v.replace(/[^\d.]/g, '')) : NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

function text(args: Args, key: string, max = 120): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
}

/** The model's search arguments, normalized. Pure. */
export function parsePropertySearchArgs(rawArgs: unknown): PropertySearchArgs {
  const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Args
  const amenities = canonicalAmenities(args.amenities)
  return {
    operation: parseOperation(args.operation),
    propertyType: parsePropertyType(args.property_type),
    zone: text(args, 'zone'),
    minPrice: num(args, 'min_price'),
    maxPrice: num(args, 'max_price') || undefined,
    minBedrooms: num(args, 'min_bedrooms'),
    minBathrooms: num(args, 'min_bathrooms'),
    minParking: num(args, 'min_parking'),
    minArea: num(args, 'min_area_m2'),
    ...(amenities.length ? { amenities } : {}),
    query: text(args, 'query', 200),
  }
}

/** Run a real estate tool, or null when `name` isn't one. */
export async function runPropertyTool(exec: RealEstateToolExec, name: string, rawArgs: unknown): Promise<string | null> {
  if (name === SEARCH_PROPERTIES_TOOL_NAME) {
    return exec.search(parsePropertySearchArgs(rawArgs))
  }
  if (name === SEND_PROPERTY_PHOTOS_TOOL_NAME && exec.sendPhotos) {
    const args = (typeof rawArgs === 'object' && rawArgs !== null ? rawArgs : {}) as Args
    const id = text(args, 'property_id', 60)
    if (!id) return JSON.stringify({ sent: 0, error: 'property_id is required: use one from search_properties.' })
    const out = await exec.sendPhotos(id)
    return JSON.stringify(
      out.sent > 0
        ? { ...out, note: 'The photos go out before your text. Do not paste links; just comment on the property.' }
        : out,
    )
  }
  return null
}
