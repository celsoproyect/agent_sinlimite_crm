import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/auth/account', () => ({ requireRole: vi.fn(), toErrorResponse: vi.fn() }))
vi.mock('@/lib/modules-server', () => ({ accountModuleEnabled: vi.fn() }))

import { parsePropertyInput } from './api'

describe('parsePropertyInput', () => {
  it('fills the defaults on create and requires a title', () => {
    expect(parsePropertyInput({ title: '' }, false)).toEqual({ error: 'title_required' })
    const res = parsePropertyInput({ title: ' Casa en Arroyo Hondo ' }, false)
    expect(res).toEqual({ input: { title: 'Casa en Arroyo Hondo', operation: 'sale', property_type: 'apartment' } })
  })

  it('only touches what a PATCH sent', () => {
    expect(parsePropertyInput({ status: 'sold' }, true)).toEqual({ input: { status: 'sold' } })
    expect(parsePropertyInput({ status: 'gone' }, true)).toEqual({ error: 'invalid_status' })
  })

  it('validates numbers and rounds bathrooms to halves', () => {
    const res = parsePropertyInput({ price: '1,250,000', bedrooms: '3', bathrooms: 2.4, area_m2: '' }, true)
    expect(res).toEqual({ input: { price: 1_250_000, bedrooms: 3, bathrooms: 2.5, area_m2: null } })
    expect(parsePropertyInput({ price: -5 }, true)).toEqual({ error: 'invalid_price' })
    expect(parsePropertyInput({ area_m2: 0 }, true)).toEqual({ error: 'invalid_area_m2' })
  })

  it('canonicalizes amenities and keeps only web photos', () => {
    const res = parsePropertyInput(
      { amenities: ['Piscina', 'alberca', 'Gimnasio'], photos: ['https://x/a.jpg', 'javascript:alert(1)', 3], currency: 'dop' },
      true,
    )
    expect(res).toEqual({ input: { amenities: ['pool', 'gym'], photos: ['https://x/a.jpg'], currency: 'DOP' } })
  })

  it('clears the advisor with an empty value', () => {
    expect(parsePropertyInput({ advisor_id: '' }, true)).toEqual({ input: { advisor_id: null } })
  })
})
