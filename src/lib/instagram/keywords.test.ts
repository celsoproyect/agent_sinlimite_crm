import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/account', () => ({ requireRole: vi.fn(), toErrorResponse: vi.fn() }))
vi.mock('@/lib/modules-server', () => ({ accountModuleEnabled: vi.fn() }))
vi.mock('@/lib/contacts/tag-events', () => ({ addContactTagAndDispatch: vi.fn() }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }))
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({ mirrorInboundMedia: vi.fn() }))

import {
  cleanKeywords,
  duplicateRule,
  isGeneralRule,
  keywordConflicts,
  matchesKeyword,
  normalizeForMatch,
  pickPublicReply,
  pickRule,
  ruleButtonPayload,
  ruleContentText,
  ruleIdFromPayload,
  normalizeRule,
  type KeywordRule,
} from './keywords'
import { parseInstagramComments } from './webhook'
import { DEFAULT_DM_OPENING, privateReplyFor } from './comments'
import { parseRuleInput, ruleProblem } from './page-api'
import { buttonColorOf, withButtonColor } from '@/components/instagram/instagram-utils'

function rule(over: Partial<KeywordRule>): KeywordRule {
  return {
    id: 'r1',
    media_id: null,
    media_ids: [],
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
    dm_media_url: null,
    dm_media_kind: null,
    dm_media_name: null,
    automation_id: null,
    triggers: ['comments'],
    require_follow: false,
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
  const own = rule({ id: 'o', media_ids: ['111'], keywords: ['precio'] })
  const anyOwn = rule({ id: 'ao', media_ids: ['111'], match_any: true })
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
  it('matches any of the posts of a multi-post rule', () => {
    const multi = rule({ id: 'm', media_ids: ['111', '222', '333'], keywords: ['info'] })
    expect(pickRule([multi], { mediaId: '222', text: 'INFO' })?.rule.id).toBe('m')
    expect(pickRule([multi], { mediaId: '444', text: 'info' })).toBeNull()
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
    const c = rule({ id: 'c', media_ids: ['1'], keywords: ['precio'] })
    expect(keywordConflicts(a, [a, b, c])).toEqual([{ keyword: 'Precio', ruleId: 'b', ruleName: 'Otra' }])
    expect(keywordConflicts(rule({ id: 'x', match_any: true }), [rule({ id: 'y', match_any: true })])).toHaveLength(1)
    expect(keywordConflicts({ ...a, active: false }, [b])).toEqual([])
  })
  it('finds conflicts between rules sharing a post', () => {
    const a = rule({ id: 'a', media_ids: ['1', '2'], keywords: ['precio'] })
    const b = rule({ id: 'b', media_ids: ['2', '3'], keywords: ['precio'] })
    const c = rule({ id: 'c', media_ids: ['4'], keywords: ['precio'] })
    expect(keywordConflicts(a, [a, b, c]).map((x) => x.ruleId)).toEqual(['b'])
  })
  it('normalizes 079 rows and duplicates rules', () => {
    const old = normalizeRule({ id: 'x', media_id: '9', name: 'Vieja', keywords: ['a'] })
    expect(old.media_ids).toEqual(['9'])
    expect(old.automation_id).toBeNull()
    expect(isGeneralRule(rule({}))).toBe(true)
    expect(isGeneralRule(old)).toBe(false)
    const copy = duplicateRule(rule({ id: 'r9', name: 'Precio', is_sample: true }), '(copia)')
    expect(copy).toMatchObject({ id: '', name: 'Precio (copia)', is_sample: false })
  })
  it('puts a color dot before the button text', () => {
    expect(withButtonColor('🟢', 'Ver precios')).toBe('🟢 Ver precios')
    expect(withButtonColor('🔵', '🟢 Ver precios')).toBe('🔵 Ver precios')
    expect(withButtonColor('', '🟢 Ver precios')).toBe('Ver precios')
    expect(buttonColorOf('🟣 Empezar')).toEqual({ color: '🟣', label: 'Empezar' })
    expect(buttonColorOf('Empezar')).toEqual({ color: '', label: 'Empezar' })
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
      { commentId: 'c1', mediaId: 'm1', mediaProductType: 'REELS', parentId: null, igsid: 'u1', username: 'ana', text: 'PRECIO', source: 'comment' },
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
  it('takes several posts, a file and an automation', () => {
    const out = parseRuleInput(
      {
        name: 'Multi',
        media_ids: ['17900000001', '17900000002', '17900000001'],
        keywords: ['pdf'],
        dm_button_label: 'Ver',
        dm_media_url: 'https://x.supabase.co/f.pdf',
        dm_media_kind: 'document',
        automation_id: '00000000-0000-0000-0000-000000000001',
      },
      false,
    )
    expect(out).toMatchObject({
      input: { media_ids: ['17900000001', '17900000002'], media_id: '17900000001', dm_media_kind: 'document' },
    })
    expect(parseRuleInput({ keywords: ['a'], dm_media_url: 'http://x/f.pdf', dm_button_label: 'V' }, false)).toEqual({ error: 'invalid_file' })
    expect(parseRuleInput({ media_ids: Array.from({ length: 101 }, (_, i) => String(10000 + i)) }, true)).toEqual({ error: 'too_many_posts' })
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

describe('threadReplyText', () => {
  it('mentions the author when the comment is itself a reply', async () => {
    const { threadReplyText } = await import('./keywords')
    expect(threadReplyText('Gracias', 'ana', 'p1')).toBe('@ana Gracias')
    expect(threadReplyText('Gracias @Ana!', 'ana', 'p1')).toBe('Gracias @Ana!')
    expect(threadReplyText(' Gracias ', 'ana', null)).toBe('Gracias')
    expect(threadReplyText('Gracias', null, 'p1')).toBe('Gracias')
  })
})
