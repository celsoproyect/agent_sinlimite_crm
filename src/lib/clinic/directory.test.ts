import { describe, expect, it } from 'vitest'
import {
  clinicSearchTool,
  formatClinicRoster,
  isOnTimeOff,
  normalizeClinicSettings,
  professionalOffersService,
  resolveService,
  formatProfessionalHours,
  normalizeText,
  resolveProfessional,
  searchProfessionals,
  shortProfessionalName,
  type ClinicDirectory,
  type ClinicService,
} from './directory'

const DIRECTORY: ClinicDirectory = {
  professionals: [
    { id: 'p1', name: 'Dra. Ana Pérez', bio: 'Pediatra con 10 años', hours: null, slotMinutes: null, specialties: ['Pediatría'] },
    {
      id: 'p2',
      name: 'Dr. Luis Gómez',
      bio: null,
      hours: { monday: { open: '08:00', close: '12:00' }, tuesday: { open: '08:00', close: '12:00' } },
      slotMinutes: 30,
      specialties: ['Cardiología', 'Medicina interna'],
    },
    { id: 'p3', name: 'Dr. Luis Martínez', bio: null, hours: null, slotMinutes: null, specialties: [] },
  ],
  specialties: ['Cardiología', 'Medicina interna', 'Pediatría'],
}

describe('normalizeText', () => {
  it('drops accents, case and extra spaces', () => {
    expect(normalizeText('  Pediatría   Infantil ')).toBe('pediatria infantil')
  })
})

describe('shortProfessionalName', () => {
  it('strips a leading title', () => {
    expect(shortProfessionalName('Dra. Ana Pérez')).toBe('Ana Pérez')
    expect(shortProfessionalName('Dr Luis')).toBe('Luis')
    expect(shortProfessionalName('Ana Pérez')).toBe('Ana Pérez')
    expect(shortProfessionalName('Dr.')).toBe('Dr.')
  })
})

describe('searchProfessionals', () => {
  it('matches a specialty without accents', () => {
    expect(searchProfessionals(DIRECTORY, { specialty: 'cardiologia' }).map((p) => p.id)).toEqual(['p2'])
  })

  it('matches a free-text query by name or specialty', () => {
    expect(searchProfessionals(DIRECTORY, { query: 'luis' }).map((p) => p.id)).toEqual(['p2', 'p3'])
    expect(searchProfessionals(DIRECTORY, { query: 'Dr. Luis Gom' }).map((p) => p.id)).toEqual(['p2'])
    expect(searchProfessionals(DIRECTORY, { query: 'pediatria' }).map((p) => p.id)).toEqual(['p1'])
  })

  it('returns everyone with no filters and nobody for an unknown specialty', () => {
    expect(searchProfessionals(DIRECTORY, {})).toHaveLength(3)
    expect(searchProfessionals(DIRECTORY, { specialty: 'Dermatología' })).toEqual([])
  })
})

describe('resolveProfessional', () => {
  it('resolves by id or by an unambiguous name', () => {
    expect(resolveProfessional(DIRECTORY, 'p3')?.id).toBe('p3')
    expect(resolveProfessional(DIRECTORY, 'Ana')?.id).toBe('p1')
  })

  it('refuses an ambiguous or unknown name', () => {
    expect(resolveProfessional(DIRECTORY, 'Luis')).toBeNull()
    expect(resolveProfessional(DIRECTORY, 'Pedro')).toBeNull()
    expect(resolveProfessional(DIRECTORY, '')).toBeNull()
  })
})

describe('formatProfessionalHours', () => {
  it('groups consecutive days with the same hours', () => {
    expect(
      formatProfessionalHours({
        monday: { open: '08:00', close: '12:00' },
        tuesday: { open: '08:00', close: '12:00' },
        wednesday: { open: '08:00', close: '12:00' },
        friday: { open: '08:00', close: '12:00' },
        saturday: { open: '09:00', close: '13:00' },
      }),
    ).toBe('Mon-Wed 08:00-12:00; Fri 08:00-12:00; Sat 09:00-13:00')
  })

  it('is null for business hours', () => {
    expect(formatProfessionalHours(null)).toBeNull()
    expect(formatProfessionalHours({ monday: null })).toBeNull()
  })
})

describe('formatClinicRoster', () => {
  it('lists every doctor with specialties, own hours and id', () => {
    expect(formatClinicRoster(DIRECTORY).split('\n')).toEqual([
      '- Dra. Ana Pérez — Pediatría (professional_id: p1)',
      '- Dr. Luis Gómez — Cardiología, Medicina interna — hours: Mon-Tue 08:00-12:00 (professional_id: p2)',
      '- Dr. Luis Martínez — general (professional_id: p3)',
    ])
  })
})

describe('clinicSearchTool', () => {
  it('returns summaries with ids, hours and bio', () => {
    expect(clinicSearchTool(DIRECTORY).find({ specialty: 'pediatria' })).toEqual([
      {
        professional_id: 'p1',
        name: 'Dra. Ana Pérez',
        specialties: ['Pediatría'],
        hours: 'same as the business hours',
        about: 'Pediatra con 10 años',
      },
    ])
  })
})

const CONSULTA: ClinicService = {
  id: 's1',
  name: 'Consulta general',
  description: null,
  specialty: null,
  durationMinutes: 20,
  price: 1500,
}
const ECO: ClinicService = {
  id: 's2',
  name: 'Ecocardiograma',
  description: 'Ayuno no necesario',
  specialty: 'Cardiología',
  durationMinutes: 45,
  price: null,
}
const EXTENDED: ClinicDirectory = {
  ...DIRECTORY,
  professionals: DIRECTORY.professionals.map((p) =>
    p.id === 'p1' ? { ...p, timeOff: [{ from: '2026-10-12', to: '2026-10-16' }] } : p,
  ),
  services: [CONSULTA, ECO],
  insurance: { ask: true, insurers: ['Humano', 'Senasa'] },
}

describe('formatClinicRoster (services, time off, insurance)', () => {
  const roster = formatClinicRoster(EXTENDED)

  it("adds each doctor's days off", () => {
    expect(roster).toContain('- Dra. Ana Pérez — Pediatría — away 2026-10-12 to 2026-10-16 (professional_id: p1)')
  })

  it('lists the services with length, specialty, price and id', () => {
    expect(roster).toContain('- Consulta general — any doctor, 20 min, RD$1,500 (service_id: s1)')
    expect(roster).toContain('- Ecocardiograma — Cardiología only, 45 min — Ayuno no necesario (service_id: s2)')
  })

  it('asks for the insurance and names the accepted insurers', () => {
    expect(roster).toContain('Health insurance')
    expect(roster).toContain('Humano, Senasa')
  })

  it('says nothing about insurance when it is off', () => {
    expect(formatClinicRoster({ ...EXTENDED, insurance: { ask: false, insurers: ['Humano'] } })).not.toContain('Health insurance')
  })
})

describe('clinicSearchTool flags', () => {
  it('exposes service_id and insurance only when configured', () => {
    expect(clinicSearchTool(DIRECTORY)).toMatchObject({ services: false, insurance: false })
    expect(clinicSearchTool(EXTENDED)).toMatchObject({ services: true, insurance: true })
  })

  it('shows the days off in the summaries', () => {
    expect(clinicSearchTool(EXTENDED).find({ query: 'ana' })[0]).toMatchObject({
      away: [{ from: '2026-10-12', to: '2026-10-16' }],
    })
  })
})

describe('resolveService', () => {
  it('matches the id or an exact name, ignoring accents and case', () => {
    expect(resolveService(EXTENDED, 's2')?.id).toBe('s2')
    expect(resolveService(EXTENDED, 'consulta GENERAL')?.id).toBe('s1')
    expect(resolveService(EXTENDED, 'Rayos X')).toBeNull()
    expect(resolveService(EXTENDED, '')).toBeNull()
  })
})

describe('professionalOffersService', () => {
  it('limits a specialty service to the doctors of that specialty', () => {
    const [ana, luis] = DIRECTORY.professionals
    expect(professionalOffersService(ana, CONSULTA)).toBe(true)
    expect(professionalOffersService(ana, ECO)).toBe(false)
    expect(professionalOffersService(luis, ECO)).toBe(true)
  })
})

describe('isOnTimeOff', () => {
  it('covers both ends of the range', () => {
    const ana = EXTENDED.professionals[0]
    expect(isOnTimeOff(ana, '2026-10-11')).toBe(false)
    expect(isOnTimeOff(ana, '2026-10-12')).toBe(true)
    expect(isOnTimeOff(ana, '2026-10-16')).toBe(true)
    expect(isOnTimeOff(ana, '2026-10-17')).toBe(false)
    expect(isOnTimeOff(DIRECTORY.professionals[1], '2026-10-12')).toBe(false)
  })
})

describe('normalizeClinicSettings', () => {
  it('maps the stored settings and drops junk', () => {
    expect(normalizeClinicSettings({ ask_insurance: true, insurers: [' Humano ', 'Humano', 3, ''] })).toEqual({
      ask: true,
      insurers: ['Humano'],
    })
    expect(normalizeClinicSettings(null)).toEqual({ ask: false, insurers: [] })
  })
})
