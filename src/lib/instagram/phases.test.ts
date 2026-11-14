import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/account', () => ({ requireRole: vi.fn(), toErrorResponse: vi.fn() }))
vi.mock('@/lib/modules-server', () => ({ accountModuleEnabled: vi.fn() }))
vi.mock('@/lib/contacts/tag-events', () => ({ addContactTagAndDispatch: vi.fn() }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: vi.fn() }))
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({ mirrorInboundMedia: vi.fn() }))

import { DEFAULT_COMMENT_ACTIONS, normalizeInstagramSettings, profileChanged } from './settings'
import { buildCommentPrompt, parseCommentVerdict } from './comment-ai'
import { formatOfferForAgent, hasOffer, offerExpired, toPostOffer } from './offers'
import { computePostReport, type ReportComment } from './report'
import { remainingDms } from './comments'
import { parseInstagramComments } from './webhook'
import { normalizeRule, pickMessageRule, pickRule, type KeywordRule } from './keywords'
import { parseEngagementPayload, profileInput, resolveEngagementTap } from './engagement'
import { messengerProfileBody } from './api'
import { parseOfferInput } from './page-api'

const RULE_ID = '11111111-1111-1111-1111-111111111111'

function rule(over: Partial<KeywordRule>): KeywordRule {
  return { ...normalizeRule({ id: 'r', keywords: [], public_replies: [] }), active: true, ...over }
}

describe('instagram settings', () => {
  it('fills defaults and clamps the hourly limit', () => {
    const s = normalizeInstagramSettings(null)
    expect(s.ai_comments.enabled).toBe(false)
    expect(s.ai_comments.actions).toEqual(DEFAULT_COMMENT_ACTIONS)
    expect(s.dm_hourly_limit).toBe(180)
    expect(normalizeInstagramSettings({ dm_hourly_limit: 999 }).dm_hourly_limit).toBe(200)
    expect(normalizeInstagramSettings({ dm_hourly_limit: 0 }).dm_hourly_limit).toBe(1)
  })

  it('keeps at most 4 ice breakers and drops incomplete menu items', () => {
    const s = normalizeInstagramSettings({
      ice_breakers: [{ question: 'a' }, { question: '' }, { question: 'b' }, { question: 'c' }, { question: 'd' }, { question: 'e' }],
      menu: [
        { title: 'Web', kind: 'url', url: 'https://x.com' },
        { title: 'Bad', kind: 'url', url: 'javascript:alert(1)' },
        { title: 'Rule', kind: 'rule' },
        { title: 'Ask', kind: 'whatever' },
      ],
    })
    expect(s.ice_breakers.map((i) => i.question)).toEqual(['a', 'b', 'c', 'd'])
    expect(s.menu.map((m) => [m.title, m.kind])).toEqual([
      ['Web', 'url'],
      ['Ask', 'ai'],
    ])
  })

  it('detects a profile change', () => {
    const a = normalizeInstagramSettings({ ice_breakers: [{ question: 'a' }] })
    expect(profileChanged(a, normalizeInstagramSettings({ ice_breakers: [{ question: 'a' }], mention_thanks: 'x' }))).toBe(false)
    expect(profileChanged(a, normalizeInstagramSettings({}))).toBe(true)
  })
})

describe('comment AI', () => {
  it('parses a verdict, even wrapped in text', () => {
    expect(parseCommentVerdict('Sure: {"category":"Question","public_reply":"¡Te escribimos por DM! 📩","private_reply":"**Hola**"}')).toEqual({
      category: 'question',
      publicReply: '¡Te escribimos por DM! 📩',
      privateReply: 'Hola',
    })
    expect(parseCommentVerdict('{"category":"nope"}')).toBeNull()
    expect(parseCommentVerdict('no json')).toBeNull()
    expect(parseCommentVerdict(null)).toBeNull()
  })

  it('puts the owner rules and the post offer in the prompt', () => {
    const prompt = buildCommentPrompt({
      businessPrompt: 'Spa',
      ownerInstructions: 'Nunca precios en público',
      catalogNames: ['Facial'],
      knowledge: [],
      post: { caption: 'Promo', offer: toPostOffer({ offer_text: '2x1', offer_expires_on: '2026-12-01' }, null) },
    })
    expect(prompt).toContain('Nunca precios en público')
    expect(prompt).toContain('2x1')
    expect(prompt).toContain('2026-12-01')
    expect(prompt).toContain('- Facial')
  })
})

describe('post offers', () => {
  it('knows when there is an offer and when it expired', () => {
    expect(hasOffer({})).toBe(false)
    expect(hasOffer({ offer_text: '  ' })).toBe(false)
    expect(hasOffer({ offer_link_url: 'https://x' })).toBe(true)
    expect(offerExpired('2026-11-12', '2026-11-13')).toBe(true)
    expect(offerExpired('2026-11-13', '2026-11-13')).toBe(false)
    expect(offerExpired(null, '2026-11-13')).toBe(false)
  })

  it('tells the agent which post the customer means', () => {
    const block = formatOfferForAgent({ caption: 'Reel del 2x1', kind: 'reel' }, toPostOffer({ offer_text: '2x1 facial' }, 'Facial'))
    expect(block).toContain('reel «Reel del 2x1»')
    expect(block).toContain('2x1 facial')
    expect(block).toContain('"Facial"')
  })

  it('validates the offer body', () => {
    expect(parseOfferInput({ offer_text: 'x', offer_expires_on: '2026-12-01' })).toEqual({
      input: { offer_text: 'x', offer_expires_on: '2026-12-01' },
    })
    expect(parseOfferInput({ offer_expires_on: '01/12/2026' })).toEqual({ error: 'invalid_date' })
    expect(parseOfferInput({ offer_link_url: 'ftp://x' })).toEqual({ error: 'invalid_link' })
    expect(parseOfferInput({})).toEqual({ error: 'invalid_body' })
    expect(parseOfferInput({ ai_comments_enabled: false })).toEqual({ input: { ai_comments_enabled: false } })
  })
})

describe('post report', () => {
  const c = (over: Partial<ReportComment>): ReportComment => ({
    media_id: 'm1',
    igsid: 'u1',
    rule_id: null,
    ai_category: null,
    dm_status: null,
    contact_id: null,
    conversation_id: null,
    created_at: '2026-11-10T10:00:00Z',
    source: 'comment',
    ...over,
  })

  it('counts comments → DMs → replies → leads → sales per post', () => {
    const { posts, total } = computePostReport({
      comments: [
        c({ rule_id: 'r', dm_status: 'delivered', contact_id: 'k1', conversation_id: 'v1' }),
        c({ ai_category: 'question', dm_status: 'sent', contact_id: 'k2', conversation_id: 'v2', igsid: 'u2' }),
        c({ dm_status: 'queued', igsid: 'u3' }),
        c({ source: 'story_reply', media_id: 'm1' }),
        c({ media_id: 'm2', source: 'live' }),
      ],
      deals: [
        { contact_id: 'k1', created_at: '2026-11-10T11:00:00Z', status: 'won', value: 100, currency: 'DOP' },
        { contact_id: 'k2', created_at: '2026-11-09T11:00:00Z', status: 'open', value: null, currency: null },
      ],
      customerMessages: new Map([['v1', ['2026-11-10T10:05:00Z']]]),
    })
    const m1 = posts.find((p) => p.mediaId === 'm1')!
    expect(m1).toMatchObject({ comments: 3, byRule: 1, byAi: 1, dmsSent: 2, queued: 1, replied: 1, leads: 1, sales: 1, revenue: { DOP: 100 } })
    expect(total.comments).toBe(4)
  })
})

describe('DM queue budget', () => {
  it('never goes below zero', () => {
    expect(remainingDms(180, 10)).toBe(170)
    expect(remainingDms(180, 300)).toBe(0)
  })
})

describe('live comments', () => {
  it('parses live_comments as live', () => {
    const out = parseInstagramComments({
      id: 'me',
      changes: [{ field: 'live_comments', value: { id: 'c1', text: 'precio', from: { id: 'u1', username: 'ana' }, media: { id: 'm1' } } }],
    })
    expect(out[0]).toMatchObject({ commentId: 'c1', source: 'live' })
  })
})

describe('rule triggers', () => {
  it('pickRule only uses rules that listen on comments', () => {
    const dmOnly = rule({ id: 'd', keywords: ['precio'], triggers: ['dms'] })
    expect(pickRule([dmOnly], { mediaId: null, text: 'precio' })).toBeNull()
    expect(pickRule([dmOnly], { mediaId: null, text: 'precio' }, 'dms')?.rule.id).toBe('d')
  })

  it('pickMessageRule takes general rules; any-comment only on story replies', () => {
    const own = rule({ id: 'o', keywords: ['precio'], media_ids: ['m1'], triggers: ['dms'] })
    const any = rule({ id: 'a', match_any: true, triggers: ['story_replies', 'dms'] })
    const general = rule({ id: 'g', keywords: ['precio'], triggers: ['dms'] })
    expect(pickMessageRule([own, general], 'el precio?', 'dms')?.rule.id).toBe('g')
    expect(pickMessageRule([any], 'hola', 'dms')).toBeNull()
    expect(pickMessageRule([any], 'hola', 'story_replies')?.rule.id).toBe('a')
  })
})

describe('ice breakers and menu', () => {
  const settings = normalizeInstagramSettings({
    ice_breakers: [{ question: '¿Precios?', rule_id: RULE_ID }, { question: '¿Horario?' }],
    menu: [
      { title: 'Web', kind: 'url', url: 'https://x.com' },
      { title: 'Catálogo', kind: 'rule', rule_id: RULE_ID },
      { title: 'Pregunta', kind: 'ai' },
    ],
  })

  it('builds the Instagram profile body', () => {
    const body = messengerProfileBody(profileInput(settings)) as {
      ice_breakers: { call_to_actions: { payload: string }[] }[]
      persistent_menu: { call_to_actions: Record<string, string>[] }[]
    }
    expect(body.ice_breakers[0].call_to_actions.map((c) => c.payload)).toEqual(['IGICE:0', 'IGICE:1'])
    expect(body.persistent_menu[0].call_to_actions[0]).toEqual({ type: 'web_url', title: 'Web', url: 'https://x.com' })
    expect(body.persistent_menu[0].call_to_actions[1]).toMatchObject({ type: 'postback', payload: 'IGMENU:1' })
  })

  it('resolves taps', () => {
    expect(parseEngagementPayload('IGRULE:x')).toBeNull()
    expect(parseEngagementPayload('IGMENU:2')).toEqual({ kind: 'menu', index: 2 })
    expect(resolveEngagementTap(settings, 'IGICE:0')).toEqual({ action: 'rule', ruleId: RULE_ID })
    expect(resolveEngagementTap(settings, 'IGICE:1')).toEqual({ action: 'ai' })
    expect(resolveEngagementTap(settings, 'IGMENU:0')).toEqual({ action: 'url', url: 'https://x.com', title: 'Web' })
    expect(resolveEngagementTap(settings, 'IGMENU:9')).toEqual({ action: 'ai' })
    expect(resolveEngagementTap(settings, null)).toBeNull()
  })
})
