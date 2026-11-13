import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/account', () => ({ requireRole: vi.fn(), toErrorResponse: vi.fn() }))
vi.mock('@/lib/modules-server', () => ({ accountModuleEnabled: vi.fn() }))
vi.mock('@/lib/contacts/tag-events', () => ({ addContactTagAndDispatch: vi.fn() }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }))
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({ mirrorInboundMedia: vi.fn() }))

import {
  cleanKeywords,
  keywordConflicts,
  matchesKeyword,
  normalizeForMatch,
  pickPublicReply,
  pickRule,
  ruleButtonPayload,
  ruleContentText,
  ruleIdFromPayload,
  type KeywordRule,
} from './keywords'
import { parseInstagramComments } from './webhook'
import { DEFAULT_DM_OPENING, privateReplyFor } from './comments'
import { parseRuleInput, ruleProblem } from './page-api'

function rule(over: Partial<KeywordRule>): KeywordRule {
  return {
    id: 'r1',
    media_id: null,
    name: 'Regla',
    keywords: [],
    match_any: false,
    public_replies: [],
    dm_opening: null,
    dm_button_label: null,
    dm_text: '',
    dm_link_url: null,
    catalog_item_id: null,
    tag_id: null,
    once_per_user: true,
    active: true,
    ...over,
  }
}

describe('keyword matching', () => {
  it('ignores case, accents and punctuation', () => {
    expect(normalizeForMatch('¡PRÉCIO!! 🔥')).toBe('precio')
    expect(matchesKeyword('¡Precio por favor!', 'PRECIO')).toBe(true)
    expect(matchesKeyword('información', 'informacion')).toBe(true)
  })
  it('matches whole words only', () => {
    expect(matchesKeyword('qué preciosa', 'precio')).toBe(false)
    expect(matchesKeyword('lo quiero ya', 'quiero ya')).toBe(true)
    expect(matchesKeyword('quiero', '  ')).toBe(false)
  })
})

describe('pickRule', () => {
  const general = rule({ id: 'g', keywords: ['precio'] })
  const own = rule({ id: 'o', media_id: '111', keywords: ['precio'] })
  const anyOwn = rule({ id: 'ao', media_id: '111', match_any: true })
  const anyGeneral = rule({ id: 'ag', match_any: true })

  it("prefers the post's own keyword rule", () => {
    expect(pickRule([general, own], { mediaId: '111', text: 'PRECIO' })?.rule.id).toBe('o')
    expect(pickRule([general, own], { mediaId: '222', text: 'precio' })?.rule.id).toBe('g')
  })
  it('falls back to "any comment" rules, the post first', () => {
    expect(pickRule([general, anyOwn, anyGeneral], { mediaId: '111', text: 'lindo' })?.rule.id).toBe('ao')
    expect(pickRule([general, anyOwn, anyGeneral], { mediaId: '111', text: 'precio' })?.rule.id).toBe('g')
    expect(pickRule([anyGeneral], { mediaId: '999', text: 'hola' })).toEqual({ rule: anyGeneral, keyword: null })
  })
  it('skips inactive rules', () => {
    expect(pickRule([rule({ keywords: ['precio'], active: false })], { mediaId: null, text: 'precio' })).toBeNull()
  })
})

describe('rule helpers', () => {
  it('cleans keyword lists', () => {
    expect(cleanKeywords([' Precio ', 'precio', 'PRÉCIO', '', 'info'])).toEqual(['Precio', 'info'])
  })
  it('finds conflicts in the same scope only', () => {
    const a = rule({ id: 'a', keywords: ['Precio'] })
    const b = rule({ id: 'b', name: 'Otra', keywords: ['precio', 'info'] })
    const c = rule({ id: 'c', media_id: '1', keywords: ['precio'] })
    expect(keywordConflicts(a, [a, b, c])).toEqual([{ keyword: 'Precio', ruleId: 'b', ruleName: 'Otra' }])
    expect(keywordConflicts(rule({ id: 'x', match_any: true }), [rule({ id: 'y', match_any: true })])).toHaveLength(1)
    expect(keywordConflicts({ ...a, active: false }, [b])).toEqual([])
  })
  it('rotates public replies and fills the username', () => {
    expect(pickPublicReply(['Listo {{username}} 📩', 'Otra'], 'ana', () => 0)).toBe('Listo @ana 📩')
    expect(pickPublicReply(['Listo {{username}}!'], null, () => 0)).toBe('Listo !')
    expect(pickPublicReply([' ', ''], 'ana')).toBeNull()
  })
  it('builds the content and the button payload', () => {
    expect(ruleContentText({ dm_text: 'Info', dm_link_url: 'https://x.y' })).toBe('Info\n\nhttps://x.y')
    expect(ruleIdFromPayload(ruleButtonPayload('abc'))).toBe('abc')
    expect(ruleIdFromPayload('OTHER')).toBeNull()
  })
})

describe('privateReplyFor', () => {
  it('sends the opening and a button when the rule has one', () => {
    expect(privateReplyFor(rule({ id: 'z', dm_button_label: 'Enviar info', dm_text: 'Info' }))).toEqual({
      text: DEFAULT_DM_OPENING,
      button: { title: 'Enviar info', payload: 'IGRULE:z' },
    })
  })
  it('sends the content directly without a button', () => {
    expect(privateReplyFor(rule({ dm_text: 'Info', dm_link_url: 'https://a.b' }))).toEqual({
      text: 'Info\n\nhttps://a.b',
      button: null,
    })
    expect(privateReplyFor(rule({}))).toBeNull()
  })
})

describe('parseInstagramComments', () => {
  it('reads comments and drops our own', () => {
    const entry = {
      id: 'biz',
      changes: [
        { field: 'comments', value: { id: 'c1', text: 'PRECIO', from: { id: 'u1', username: 'ana' }, media: { id: 'm1', media_product_type: 'REELS' } } },
        { field: 'comments', value: { id: 'c2', text: 'Gracias', from: { id: 'biz', username: 'negocio' }, media: { id: 'm1' } } },
        { field: 'comments', value: { id: 'c3', text: 'Listo', from: { id: 'x', username: 'Negocio' }, media: { id: 'm1' } } },
        { field: 'mentions', value: { id: 'c4' } },
      ],
    }
    expect(parseInstagramComments(entry, 'negocio')).toEqual([
      { commentId: 'c1', mediaId: 'm1', mediaProductType: 'REELS', parentId: null, igsid: 'u1', username: 'ana', text: 'PRECIO' },
    ])
  })
})

describe('parseRuleInput', () => {
  it('accepts a full rule', () => {
    const out = parseRuleInput(
      { name: 'Precio', media_id: '17900000000', keywords: ['precio', 'Precio'], dm_text: 'Info', dm_button_label: 'Ver' },
      false,
    )
    expect(out).toMatchObject({ input: { media_id: '17900000000', keywords: ['precio'], dm_button_label: 'Ver', once_per_user: true } })
  })
  it('refuses incomplete or bad input', () => {
    expect(parseRuleInput({ dm_text: 'x' }, false)).toEqual({ error: 'keywords_required' })
    expect(parseRuleInput({ keywords: ['a'] }, false)).toEqual({ error: 'reply_required' })
    expect(parseRuleInput({ keywords: ['a'], dm_link_url: 'ftp://x' }, false)).toEqual({ error: 'invalid_link' })
    expect(parseRuleInput({ media_id: 'abc' }, true)).toEqual({ error: 'invalid_media' })
    expect(parseRuleInput(null, false)).toEqual({ error: 'invalid_body' })
  })
  it('keeps PATCH partial', () => {
    expect(parseRuleInput({ active: false }, true)).toEqual({ input: { active: false } })
  })
  it('needs a button to send a catalog picture', () => {
    expect(
      ruleProblem({
        keywords: ['a'],
        match_any: false,
        public_replies: [],
        dm_text: '',
        dm_link_url: null,
        catalog_item_id: '00000000-0000-0000-0000-000000000000',
        dm_button_label: null,
      }),
    ).toBe('catalog_needs_button')
  })
})
