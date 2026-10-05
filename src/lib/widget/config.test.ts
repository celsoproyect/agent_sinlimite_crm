import { describe, it, expect } from 'vitest'
import { DEFAULT_WIDGET_CONFIG, WIDGET_LIMITS, normalizeWidgetConfig } from './config'

describe('normalizeWidgetConfig', () => {
  it('fills every field with defaults for empty or garbage input', () => {
    expect(normalizeWidgetConfig(null)).toEqual(DEFAULT_WIDGET_CONFIG)
    expect(normalizeWidgetConfig('nope')).toEqual(DEFAULT_WIDGET_CONFIG)
    expect(normalizeWidgetConfig({})).toEqual(DEFAULT_WIDGET_CONFIG)
  })

  it('keeps valid values, trimmed', () => {
    const cfg = normalizeWidgetConfig({
      agentName: '  Aldo ',
      subtitle: 'Orientación aduanera disponible',
      avatarUrl: 'https://cdn.example.com/aldo.png',
      primaryColor: '#0A2B5C',
      quickQuestions: [{ icon: '📦', text: ' ¿Cuáles son los requisitos para importar? ' }],
    })
    expect(cfg.agentName).toBe('Aldo')
    expect(cfg.avatarUrl).toBe('https://cdn.example.com/aldo.png')
    expect(cfg.primaryColor).toBe('#0a2b5c')
    expect(cfg.quickQuestions).toEqual([
      { icon: '📦', text: '¿Cuáles son los requisitos para importar?' },
    ])
  })

  it('rejects non-http URLs and bad colors', () => {
    const cfg = normalizeWidgetConfig({
      avatarUrl: 'javascript:alert(1)',
      heroImageUrl: 'data:image/png;base64,xx',
      primaryColor: 'red',
    })
    expect(cfg.avatarUrl).toBeNull()
    expect(cfg.heroImageUrl).toBeNull()
    expect(cfg.primaryColor).toBe(DEFAULT_WIDGET_CONFIG.primaryColor)
  })

  it('drops empty questions, defaults the icon and caps the list', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ text: `Pregunta ${i}` }))
    const cfg = normalizeWidgetConfig({
      quickQuestions: [{ icon: '✈️', text: '   ' }, null, 'x', ...many],
    })
    expect(cfg.quickQuestions).toHaveLength(WIDGET_LIMITS.quickQuestions)
    expect(cfg.quickQuestions[0]).toEqual({ icon: '💬', text: 'Pregunta 0' })
  })

  it('caps long strings', () => {
    const cfg = normalizeWidgetConfig({ agentName: 'x'.repeat(500) })
    expect(cfg.agentName).toHaveLength(WIDGET_LIMITS.agentName)
  })
})
