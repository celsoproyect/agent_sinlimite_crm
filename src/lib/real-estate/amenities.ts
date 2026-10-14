// ============================================================
// Real estate module: the amenity vocabulary. Customers ask for the same
// amenity in many ways ("alberca", "piscina", "pool"; "parqueo",
// "estacionamiento", "marquesina"), so every amenity has a canonical key
// that properties store and searches compare. Words that aren't in the
// vocabulary are kept as free text (lowercased, without accents) and
// still match a property that lists the same words.
// ============================================================

export interface AmenityDef {
  key: string
  /** Spanish label shown in the UI and given to the AI. */
  es: string
  en: string
  /** Ways customers say it (normalized: lowercase, no accents). */
  synonyms: string[]
}

export const AMENITIES: AmenityDef[] = [
  { key: 'pool', es: 'Piscina', en: 'Pool', synonyms: ['piscina', 'alberca', 'pileta', 'pool', 'swimming pool'] },
  { key: 'gym', es: 'Gimnasio', en: 'Gym', synonyms: ['gimnasio', 'gym', 'gimnacio', 'fitness'] },
  {
    key: 'parking',
    es: 'Parqueo',
    en: 'Parking',
    synonyms: ['parqueo', 'parqueos', 'estacionamiento', 'parking', 'marquesina', 'garaje', 'garage', 'cochera'],
  },
  { key: 'elevator', es: 'Ascensor', en: 'Elevator', synonyms: ['ascensor', 'elevador', 'elevator', 'lift'] },
  {
    key: 'security',
    es: 'Seguridad 24h',
    en: '24h security',
    synonyms: ['seguridad', 'seguridad 24h', 'seguridad 24 horas', 'vigilancia', 'guardia', 'security', 'conserje', 'portero'],
  },
  {
    key: 'power_plant',
    es: 'Planta eléctrica',
    en: 'Backup power',
    synonyms: ['planta electrica', 'generador', 'planta full', 'inversor', 'energia de respaldo', 'generator', 'backup power'],
  },
  {
    key: 'social_area',
    es: 'Área social',
    en: 'Social area',
    synonyms: ['area social', 'salon de eventos', 'salon social', 'club house', 'clubhouse', 'social area', 'rooftop'],
  },
  { key: 'terrace', es: 'Terraza', en: 'Terrace', synonyms: ['terraza', 'terrace', 'azotea'] },
  { key: 'balcony', es: 'Balcón', en: 'Balcony', synonyms: ['balcon', 'balcony'] },
  { key: 'garden', es: 'Jardín', en: 'Garden', synonyms: ['jardin', 'patio', 'garden', 'yard', 'area verde', 'areas verdes'] },
  { key: 'furnished', es: 'Amueblado', en: 'Furnished', synonyms: ['amueblado', 'amueblada', 'furnished', 'con muebles', 'equipado', 'equipada'] },
  {
    key: 'appliances',
    es: 'Línea blanca',
    en: 'Appliances',
    synonyms: ['linea blanca', 'electrodomesticos', 'appliances', 'nevera', 'estufa'],
  },
  {
    key: 'service_room',
    es: 'Cuarto de servicio',
    en: 'Service room',
    synonyms: ['cuarto de servicio', 'habitacion de servicio', 'area de servicio', 'service room', 'maid room'],
  },
  { key: 'pets', es: 'Acepta mascotas', en: 'Pet friendly', synonyms: ['mascotas', 'mascota', 'pet friendly', 'pets', 'perro', 'perros', 'gato'] },
  { key: 'playground', es: 'Área de juegos', en: 'Playground', synonyms: ['area de juegos', 'area infantil', 'parque infantil', 'playground', 'juegos para ninos'] },
  { key: 'lobby', es: 'Lobby', en: 'Lobby', synonyms: ['lobby', 'recepcion'] },
  { key: 'cistern', es: 'Cisterna', en: 'Water tank', synonyms: ['cisterna', 'tinaco', 'deposito de agua', 'water tank'] },
  { key: 'common_gas', es: 'Gas común', en: 'Piped gas', synonyms: ['gas comun', 'gas centralizado', 'gas por tuberia', 'piped gas'] },
  { key: 'bbq', es: 'Área de BBQ', en: 'BBQ area', synonyms: ['bbq', 'barbacoa', 'parrilla', 'area de bbq', 'asador'] },
  { key: 'air_conditioning', es: 'Aire acondicionado', en: 'Air conditioning', synonyms: ['aire acondicionado', 'aires', 'a/c', 'ac', 'climatizado', 'air conditioning'] },
  { key: 'walk_in_closet', es: 'Walk-in closet', en: 'Walk-in closet', synonyms: ['walk in closet', 'walk-in closet', 'vestidor'] },
  { key: 'jacuzzi', es: 'Jacuzzi', en: 'Jacuzzi', synonyms: ['jacuzzi', 'hidromasaje', 'hot tub'] },
  { key: 'study', es: 'Estudio', en: 'Study', synonyms: ['estudio', 'oficina en casa', 'home office', 'study'] },
  { key: 'gated', es: 'Residencial cerrado', en: 'Gated community', synonyms: ['residencial cerrado', 'residencial privado', 'gated', 'gated community', 'condominio'] },
  { key: 'sea_view', es: 'Vista al mar', en: 'Sea view', synonyms: ['vista al mar', 'frente al mar', 'vista mar', 'sea view', 'ocean view'] },
  { key: 'solar_panels', es: 'Paneles solares', en: 'Solar panels', synonyms: ['paneles solares', 'solar', 'energia solar', 'solar panels'] },
]

const BY_KEY = new Map(AMENITIES.map((a) => [a.key, a]))

/** Lowercase, strip accents and punctuation, collapse spaces. */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9/ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Longest synonyms first, so "seguridad 24 horas" wins over "seguridad".
const SYNONYM_INDEX: { synonym: string; key: string }[] = AMENITIES.flatMap((a) =>
  [a.key.replace(/_/g, ' '), normalizeText(a.es), normalizeText(a.en), ...a.synonyms].map((s) => ({ synonym: s, key: a.key })),
).sort((x, y) => y.synonym.length - x.synonym.length)

/**
 * The canonical key for what a customer (or the owner) wrote, or the
 * normalized text itself when it isn't a known amenity. Empty input → null.
 */
export function canonicalAmenity(raw: string): string | null {
  const text = normalizeText(raw)
  if (!text) return null
  if (BY_KEY.has(text)) return text
  for (const { synonym, key } of SYNONYM_INDEX) {
    if (text === synonym) return key
  }
  // "con piscina", "que tenga gimnasio", "piscina para niños"
  for (const { synonym, key } of SYNONYM_INDEX) {
    if (synonym.length >= 3 && new RegExp(`(^|\\s)${escapeRegExp(synonym)}(\\s|$)`).test(text)) return key
  }
  return text
}

/** Canonical, de-duplicated amenities from any list the model or a form sent. */
export function canonicalAmenities(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\n]/) : []
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const key = canonicalAmenity(item)
    if (key && !out.includes(key)) out.push(key.slice(0, 60))
  }
  return out.slice(0, 40)
}

/** The label of a stored amenity (free text is shown as typed). */
export function amenityLabel(key: string, locale: 'es' | 'en' = 'es'): string {
  const def = BY_KEY.get(key)
  if (!def) return key.charAt(0).toUpperCase() + key.slice(1)
  return locale === 'en' ? def.en : def.es
}

export function isKnownAmenity(key: string): boolean {
  return BY_KEY.has(key)
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether normalized free `text` (a description) mentions the amenity
 *  `key` in any of its forms. */
export function amenityMentioned(text: string, key: string): boolean {
  const haystack = ` ${normalizeText(text)} `
  const def = BY_KEY.get(key)
  const forms = def ? [normalizeText(def.es), ...def.synonyms] : [key]
  return forms.some((f) => f.length >= 4 && haystack.includes(` ${f} `))
}
