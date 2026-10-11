import { describe, it, expect } from 'vitest'
import {
  becameHot,
  DEFAULT_QUALIFICATION_QUESTIONS,
  formatKnownQualification,
  formatQualificationBlock,
  mergeQualification,
  parseQualification,
  qualificationQuestionList,
} from './qualification'

describe('parseQualification', () => {
  it('keeps the known fields, trimmed, and drops an unknown temperature', () => {
    const r = parseQualification({ interest: '  Limpieza   dental ', temperature: 'boiling', budget: 5 })
    expect(r).toEqual({ qualification: { interest: 'Limpieza dental' } })
  })

  it('accepts a valid temperature and complete answers only', () => {
    const r = parseQualification({
      temperature: 'hot',
      answers: [{ question: '¿Primera visita?', answer: 'Sí' }, { question: 'Sin respuesta' }, 'x'],
    })
    expect(r).toEqual({
      qualification: { temperature: 'hot', answers: [{ question: '¿Primera visita?', answer: 'Sí' }] },
    })
  })

  it('refuses an empty call', () => {
    expect(parseQualification({})).toHaveProperty('error')
    expect(parseQualification(null)).toHaveProperty('error')
  })

  it('caps long text', () => {
    const r = parseQualification({ need: 'a'.repeat(1000) })
    expect('qualification' in r && r.qualification.need?.length).toBe(300)
  })
})

describe('mergeQualification', () => {
  const now = new Date('2026-10-11T12:00:00Z')

  it('lets new values win, keeps the old ones and merges answers by question', () => {
    const merged = mergeQualification(
      { interest: 'Botox', need: 'Boda', answers: [{ question: 'Primera visita', answer: 'No' }] },
      { need: 'Boda en diciembre', answers: [{ question: 'primera visita', answer: 'Sí' }, { question: 'Zona', answer: 'Frente' }] },
      now,
    )
    expect(merged).toEqual({
      interest: 'Botox',
      need: 'Boda en diciembre',
      answers: [
        { question: 'primera visita', answer: 'Sí' },
        { question: 'Zona', answer: 'Frente' },
      ],
      updated_at: now.toISOString(),
    })
  })

  it('works with nothing stored yet', () => {
    expect(mergeQualification(null, { temperature: 'warm' }, now)).toEqual({
      temperature: 'warm',
      updated_at: now.toISOString(),
    })
  })
})

describe('becameHot', () => {
  it('is true only on the transition to hot', () => {
    expect(becameHot({ temperature: 'warm' }, { temperature: 'hot' })).toBe(true)
    expect(becameHot(null, { temperature: 'hot' })).toBe(true)
    expect(becameHot({ temperature: 'hot' }, { temperature: 'hot' })).toBe(false)
    expect(becameHot(null, { temperature: 'warm' })).toBe(false)
  })
})

describe('formatQualificationBlock', () => {
  it('lays out one fact per line', () => {
    const block = formatQualificationBlock(
      { interest: 'Botox', timeline: 'Esta semana', temperature: 'hot', summary: 'Lista para reservar' },
      'Ana',
    )
    expect(block.split('\n')).toEqual([
      '📋 Precalificación',
      '👤 Nombre: Ana',
      '🎯 Interés: Botox',
      '📅 Cuándo: Esta semana',
      '🌡️ Temperatura: 🔥 Caliente',
      '📝 Lista para reservar',
    ])
  })

  it('is empty when only the name is known', () => {
    expect(formatQualificationBlock({}, 'Ana')).toBe('')
    expect(formatQualificationBlock(null, 'Ana')).toBe('')
  })
})

describe('formatKnownQualification', () => {
  it('digests what is known, or null', () => {
    expect(formatKnownQualification({ interest: 'Botox', temperature: 'warm' })).toBe(
      'interest: Botox; temperature: warm',
    )
    expect(formatKnownQualification({ name_confirmed: true })).toBeNull()
  })
})

describe('qualificationQuestionList', () => {
  it('takes one question per line, stripping bullets and numbers', () => {
    expect(qualificationQuestionList('1. Qué servicio\n- Para cuándo\n\n• Presupuesto')).toEqual([
      'Qué servicio',
      'Para cuándo',
      'Presupuesto',
    ])
  })

  it('falls back to the defaults', () => {
    expect(qualificationQuestionList('  ')).toEqual(DEFAULT_QUALIFICATION_QUESTIONS)
    expect(qualificationQuestionList(null)).toEqual(DEFAULT_QUALIFICATION_QUESTIONS)
  })
})
