import { describe, it, expect } from 'vitest'
import { amenityLabel, amenityMentioned, canonicalAmenities, canonicalAmenity } from './amenities'
import { amenityCoverage, parseOperation, parsePropertyType, searchProperties, zoneMatches, type Property } from './search'
import { parsePropertySearchArgs } from '@/lib/ai/providers/property-tools'

function property(overrides: Partial<Property>): Property {
  return {
    id: 'p',
    account_id: 'a',
    code: null,
    title: 'Apartamento',
    operation: 'sale',
    property_type: 'apartment',
    zone: 'Piantini',
    city: 'Santo Domingo',
    address: null,
    price: 200_000,
    currency: 'USD',
    bedrooms: 3,
    bathrooms: 2,
    parking: 2,
    area_m2: 150,
    amenities: [],
    description: null,
    photos: [],
    status: 'available',
    advisor_id: null,
    active: true,
    sort_order: 0,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    ...overrides,
  }
}

describe('amenities', () => {
  it('maps the ways customers say it to one key', () => {
    expect(canonicalAmenity('Piscina')).toBe('pool')
    expect(canonicalAmenity('alberca')).toBe('pool')
    expect(canonicalAmenity('con gimnasio')).toBe('gym')
    expect(canonicalAmenity('planta eléctrica')).toBe('power_plant')
    expect(canonicalAmenity('Seguridad 24 horas')).toBe('security')
    expect(canonicalAmenity('que acepte mascotas')).toBe('pets')
    expect(canonicalAmenity('Vista al mar')).toBe('sea_view')
  })

  it('keeps unknown amenities as normalized text and drops blanks', () => {
    expect(canonicalAmenity('Cancha de pádel')).toBe('cancha de padel')
    expect(canonicalAmenity('  ')).toBeNull()
  })

  it('de-duplicates lists and accepts comma text', () => {
    expect(canonicalAmenities(['piscina', 'Pool', 'gym'])).toEqual(['pool', 'gym'])
    expect(canonicalAmenities('piscina, ascensor; parqueo')).toEqual(['pool', 'elevator', 'parking'])
    expect(canonicalAmenities(42)).toEqual([])
  })

  it('labels known keys per locale and free text as typed', () => {
    expect(amenityLabel('power_plant', 'es')).toBe('Planta eléctrica')
    expect(amenityLabel('power_plant', 'en')).toBe('Backup power')
    expect(amenityLabel('cancha de padel')).toBe('Cancha de padel')
  })

  it('finds amenities mentioned in a description', () => {
    expect(amenityMentioned('Hermoso apto con piscina y área social', 'pool')).toBe(true)
    expect(amenityMentioned('Hermoso apto con piscina y área social', 'social_area')).toBe(true)
    expect(amenityMentioned('Hermoso apto', 'gym')).toBe(false)
  })
})

describe('parsers', () => {
  it('reads property types and operations in Spanish', () => {
    expect(parsePropertyType('apto')).toBe('apartment')
    expect(parsePropertyType('Solar')).toBe('land')
    expect(parsePropertyType('castillo')).toBeUndefined()
    expect(parseOperation('alquiler')).toBe('rent')
    expect(parseOperation('Venta')).toBe('sale')
    expect(parseOperation('permuta')).toBeUndefined()
  })

  it('matches zones loosely', () => {
    const p = { zone: 'Piantini', city: 'Santo Domingo', address: null }
    expect(zoneMatches(p, 'piantini')).toBe(true)
    expect(zoneMatches(p, 'Piantini, Santo Domingo')).toBe(true)
    expect(zoneMatches(p, 'Punta Cana')).toBe(false)
  })

  it('normalizes the model tool arguments', () => {
    expect(
      parsePropertySearchArgs({
        operation: 'renta',
        property_type: 'apartamento',
        zone: ' Naco ',
        max_price: 'US$1,500',
        min_bedrooms: 2,
        amenities: ['piscina', 'planta electrica'],
      }),
    ).toMatchObject({
      operation: 'rent',
      propertyType: 'apartment',
      zone: 'Naco',
      maxPrice: 1500,
      minBedrooms: 2,
      amenities: ['pool', 'power_plant'],
    })
    const empty = parsePropertySearchArgs(null)
    expect(empty.amenities).toBeUndefined()
    expect(empty.maxPrice).toBeUndefined()
  })
})

describe('searchProperties', () => {
  const list = [
    property({ id: 'full', price: 250_000, amenities: ['pool', 'gym', 'power_plant'] }),
    property({ id: 'half', price: 180_000, amenities: ['pool'] }),
    property({ id: 'none', price: 150_000, amenities: ['elevator'] }),
    property({ id: 'desc', price: 220_000, amenities: [], description: 'Torre con gimnasio y piscina' }),
    property({ id: 'rent', operation: 'rent', price: 1_200, amenities: ['pool', 'gym'] }),
    property({ id: 'sold', status: 'sold', amenities: ['pool', 'gym'] }),
    property({ id: 'off', active: false, amenities: ['pool', 'gym'] }),
    property({ id: 'naco', zone: 'Naco', bedrooms: 1, price: 120_000 }),
  ]

  it('applies the hard filters and skips unavailable listings', () => {
    const ids = searchProperties(list, { operation: 'sale', zone: 'Piantini', minBedrooms: 2 }, 20).map((m) => m.property.id)
    expect(ids).not.toContain('rent')
    expect(ids).not.toContain('sold')
    expect(ids).not.toContain('off')
    expect(ids).not.toContain('naco')
    expect(ids).toContain('none')
  })

  it('puts the listings with every requested amenity first and drops those with none', () => {
    const matches = searchProperties(list, { operation: 'sale', amenities: ['piscina', 'gimnasio'] }, 20)
    expect(matches.map((m) => m.property.id)).toEqual(['desc', 'full', 'half'])
    const half = matches.find((m) => m.property.id === 'half')!
    expect(half.matchedAmenities).toEqual(['pool'])
    expect(half.missingAmenities).toEqual(['gym'])
  })

  it('offers the closest to the budget first when there is one', () => {
    const ids = searchProperties(list, { operation: 'sale', zone: 'Piantini', maxPrice: 230_000 }, 20).map((m) => m.property.id)
    expect(ids).toEqual(['desc', 'half', 'none'])
  })

  it('still answers when nothing has the requested amenity', () => {
    const matches = searchProperties(list, { operation: 'sale', amenities: ['jacuzzi'] }, 20)
    expect(matches.length).toBeGreaterThan(0)
    expect(matches.every((m) => m.missingAmenities.includes('jacuzzi'))).toBe(true)
  })

  it('reports coverage per property', () => {
    expect(amenityCoverage(list[0], ['pool', 'jacuzzi'])).toEqual({ matched: ['pool'], missing: ['jacuzzi'] })
  })
})
