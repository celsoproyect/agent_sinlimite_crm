import { describe, it, expect } from 'vitest'
import { MEMBER_SECTIONS, SETTINGS_SECTIONS, resolveSection, sectionsFor } from './settings-sections'

describe('settings sections by role', () => {
  it('lets admins open every section', () => {
    expect(sectionsFor(true)).toEqual(SETTINGS_SECTIONS)
    expect(resolveSection('api', true)).toBe('api')
    expect(resolveSection('tags', true)).toBe('fields')
    expect(resolveSection(null, true)).toBe('overview')
  })

  it('keeps agents and viewers on their own settings, even by URL', () => {
    expect(sectionsFor(false)).toEqual(MEMBER_SECTIONS)
    for (const tab of ['whatsapp', 'ai-agent', 'members', 'plan', 'api', 'templates', 'fields', 'deals', 'tags', null]) {
      expect(resolveSection(tab, false)).toBe('profile')
    }
    expect(resolveSection('security', false)).toBe('security')
    expect(resolveSection('quick-replies', false)).toBe('quick-replies')
  })
})
