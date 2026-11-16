import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/account', () => ({ requireRole: vi.fn(), toErrorResponse: vi.fn() }))
vi.mock('@/lib/modules-server', () => ({ accountModuleEnabled: vi.fn() }))
vi.mock('@/lib/contacts/tag-events', () => ({ addContactTagAndDispatch: vi.fn() }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }))
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({ mirrorInboundMedia: vi.fn() }))

import {
  computeLinkStats,
  formatLinkForAgent,
  igMeUrl,
  linkProblem,
  newLinkSlug,
  normalizeLinkCode,
  parseLinkInput,
  sameCode,
  shortLinkUrl,
} from './links'

describe('campaign link codes and URLs', () => {
  it('normalizes the code the owner types', () => {
    expect(normalizeLinkCode(' qr local ')).toBe('QR_LOCAL')
    expect(normalizeLinkCode('Promoción-1')).toBe('PROMOCION-1')
    expect(normalizeLinkCode('a')).toBeNull()
    expect(normalizeLinkCode('hola!')).toBeNull()
    expect(normalizeLinkCode(5)).toBeNull()
  })

  it('builds the ig.me and short URLs', () => {
    expect(igMeUrl('mi.tienda', 'QR_LOCAL')).toBe('https://ig.me/m/mi.tienda?ref=QR_LOCAL')
    expect(shortLinkUrl('https://crm.example.com/', 'abcd2345')).toBe('https://crm.example.com/go/abcd2345')
    expect(newLinkSlug()).toMatch(/^[a-z2-9]{8}$/)
    expect(sameCode(' qr_local', 'QR_LOCAL')).toBe(true)
    expect(sameCode(null, 'QR')).toBe(false)
  })

  it('gives the agent the link and its context', () => {
    const text = formatLinkForAgent({ name: 'QR del local', code: 'QR_LOCAL', ai_context: '10% de descuento' })
    expect(text).toContain('QR del local')
    expect(text).toContain('QR_LOCAL')
    expect(text).toContain('10% de descuento')
  })
})

describe('parseLinkInput', () => {
  const RULE = '11111111-1111-1111-1111-111111111111'
  it('requires what the action sends', () => {
    expect(parseLinkInput({ name: 'A', code: 'QR', action: 'message' }, false)).toEqual({ error: 'welcome_required' })
    expect(parseLinkInput({ name: 'A', code: 'QR', action: 'rule' }, false)).toEqual({ error: 'rule_required' })
    expect(parseLinkInput({ name: 'A', code: 'QR', action: 'automation' }, false)).toEqual({ error: 'automation_required' })
    expect(parseLinkInput({ name: 'A', code: 'QR', action: 'ai' }, false)).toHaveProperty('input')
    expect(parseLinkInput({ name: '', code: 'QR', action: 'ai' }, false)).toEqual({ error: 'name_required' })
    expect(parseLinkInput({ name: 'A', code: '!', action: 'ai' }, false)).toEqual({ error: 'invalid_code' })
    expect(parseLinkInput({ name: 'A', code: 'QR', action: 'rule', rule_id: 'x' }, false)).toEqual({ error: 'invalid_reference' })
  })

  it('parses a full link and a partial update', () => {
    const full = parseLinkInput({ name: ' Bio ', code: 'bio', action: 'rule', rule_id: RULE, welcome_text: ' Hola ' }, false)
    expect(full).toEqual({
      input: {
        name: 'Bio',
        code: 'BIO',
        action: 'rule',
        welcome_text: 'Hola',
        ai_context: null,
        rule_id: RULE,
        automation_id: null,
        tag_id: null,
      },
    })
    expect(parseLinkInput({ active: false }, true)).toEqual({ input: { active: false } })
    expect(linkProblem({ action: 'message', welcome_text: 'Hola' })).toBeNull()
  })
})

describe('computeLinkStats', () => {
  it('counts clicks, chats, new contacts and the deals after the arrival', () => {
    const stats = computeLinkStats(
      [
        { link_id: 'L1', kind: 'click', contact_id: null, is_new_contact: false, created_at: '2026-11-10T10:00:00Z' },
        { link_id: 'L1', kind: 'click', contact_id: null, is_new_contact: false, created_at: '2026-11-10T10:01:00Z' },
        { link_id: 'L1', kind: 'open', contact_id: 'C1', is_new_contact: true, created_at: '2026-11-10T10:02:00Z' },
        { link_id: 'L1', kind: 'open', contact_id: 'C2', is_new_contact: false, created_at: '2026-11-11T10:00:00Z' },
        { link_id: 'L2', kind: 'open', contact_id: 'C3', is_new_contact: true, created_at: '2026-11-12T10:00:00Z' },
      ],
      [
        { contact_id: 'C1', status: 'won', value: 1500, created_at: '2026-11-10T12:00:00Z' },
        // Before C2 arrived by the link: not the link's.
        { contact_id: 'C2', status: 'open', value: 300, created_at: '2026-11-01T12:00:00Z' },
        { contact_id: 'C3', status: 'open', value: 300, created_at: '2026-11-12T11:00:00Z' },
      ],
    )
    expect(stats.get('L1')).toEqual({ clicks: 2, chats: 2, newContacts: 1, deals: 1, won: 1, revenue: 1500 })
    expect(stats.get('L2')).toEqual({ clicks: 0, chats: 1, newContacts: 1, deals: 1, won: 0, revenue: 0 })
  })
})
