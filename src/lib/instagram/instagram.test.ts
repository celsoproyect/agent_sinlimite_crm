import { describe, expect, it } from 'vitest'
import { splitInstagramText, toInstagramText } from './format'
import { signInstagramState, verifyInstagramState } from './api'
import { describeInstagramEvent, parseInstagramEntry, referralSource } from './webhook'
import { rememberSentMid, wasSentByUs } from './send'

describe('toInstagramText', () => {
  it('drops WhatsApp markers and keeps the structure', () => {
    expect(toInstagramText('*Precio:* 50\n• _uno_\n~viejo~ `code`')).toBe('Precio: 50\n• uno\nviejo code')
    expect(toInstagramText('**negrita**')).toBe('negrita')
  })
  it('keeps underscores inside words', () => {
    expect(toInstagramText('mi_usuario_123')).toBe('mi_usuario_123')
  })
})

describe('splitInstagramText', () => {
  it('returns one part when it fits', () => {
    expect(splitInstagramText('hola')).toEqual(['hola'])
    expect(splitInstagramText('   ')).toEqual([])
  })
  it('cuts at paragraph breaks and respects the byte limit', () => {
    const para = 'á'.repeat(300) // 600 bytes
    const parts = splitInstagramText(`${para}\n\n${para}\n\n${para}`)
    expect(parts.length).toBe(3)
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(1000)
    expect(parts.join('')).toBe(para.repeat(3))
  })
  it('cuts inside a word as a last resort', () => {
    const parts = splitInstagramText('x'.repeat(2500), 1000)
    expect(parts.map((p) => p.length)).toEqual([1000, 1000, 500])
  })
})

describe('OAuth state', () => {
  it('round-trips and tolerates the #_ suffix', () => {
    const now = 1_700_000_000_000
    const state = signInstagramState('acc', 'usr', now)
    expect(verifyInstagramState(state, now + 1000)).toEqual({ accountId: 'acc', userId: 'usr' })
    expect(verifyInstagramState(`${state}#_`, now + 1000)).toEqual({ accountId: 'acc', userId: 'usr' })
  })
  it('rejects tampered, missing and stale states', () => {
    const now = 1_700_000_000_000
    const state = signInstagramState('acc', 'usr', now)
    expect(verifyInstagramState(null, now)).toBeNull()
    expect(verifyInstagramState(`${state}x`, now)).toBeNull()
    expect(verifyInstagramState(state, now + 24 * 60 * 60 * 1000)).toBeNull()
  })
})

const BIZ = '1784'

describe('parseInstagramEntry', () => {
  it('splits messages, echoes, postbacks, referrals and reads', () => {
    const events = parseInstagramEntry({
      id: BIZ,
      messaging: [
        { sender: { id: 'u1' }, recipient: { id: BIZ }, timestamp: 1, message: { mid: 'm1', text: 'hola' } },
        { sender: { id: BIZ }, recipient: { id: 'u1' }, timestamp: 2, message: { mid: 'm2', text: 'hey', is_echo: true } },
        { sender: { id: 'u1' }, recipient: { id: BIZ }, timestamp: 3, message: { mid: 'm3', is_deleted: true } },
        { sender: { id: 'u1' }, recipient: { id: BIZ }, timestamp: 4, postback: { mid: 'p1', title: 'Precios', payload: 'PRICES' } },
        { sender: { id: 'u1' }, recipient: { id: BIZ }, timestamp: 5, referral: { ref: 'promo', source: 'SHORTLINK' } },
        { sender: { id: 'u1' }, recipient: { id: BIZ }, timestamp: 6, read: { mid: 'm2' } },
      ],
    })
    expect(events.map((e) => e.kind)).toEqual(['message', 'echo', 'postback', 'referral', 'read'])
    expect(events[1]).toMatchObject({ kind: 'echo', igsid: 'u1', mid: 'm2' })
  })
})

describe('describeInstagramEvent', () => {
  function message(extra: Record<string, unknown>) {
    const [event] = parseInstagramEntry({
      id: BIZ,
      messaging: [{ sender: { id: 'u1' }, recipient: { id: BIZ }, timestamp: 1000, message: { mid: 'm1', ...extra } }],
    })
    if (event.kind !== 'message') throw new Error('expected a message')
    return describeInstagramEvent(event)
  }

  it('turns plain text into one text part', () => {
    expect(message({ text: 'hola' }).parts).toEqual([
      { mid: 'm1', contentType: 'text', contentText: 'hola', mediaUrl: null, interactiveReplyId: null },
    ])
  })

  it('notes a story reply and keeps it as the source', () => {
    const out = message({ text: 'precio?', reply_to: { story: { id: 's1', url: 'https://cdn/s1' } } })
    expect(out.parts[0].contentText).toBe('[Respondió a tu historia] precio?')
    expect(out.source).toMatchObject({ type: 'story_reply', id: 's1' })
  })

  it('notes a shared reel with its caption', () => {
    const out = message({ attachments: [{ type: 'ig_reel', payload: { reel_video_id: 'r1', title: 'Promo verano', url: 'https://cdn/r1' } }] })
    expect(out.parts[0].contentText).toBe('[Compartió un reel: «Promo verano»]')
    expect(out.source).toMatchObject({ type: 'shared_reel', id: 'r1', title: 'Promo verano' })
  })

  it('gives each media attachment its own part', () => {
    const out = message({
      text: 'mira',
      attachments: [
        { type: 'image', payload: { url: 'https://cdn/a' } },
        { type: 'file', payload: { url: 'https://cdn/b' } },
      ],
    })
    expect(out.parts).toEqual([
      { mid: 'm1', contentType: 'image', contentText: 'mira', mediaUrl: 'https://cdn/a', interactiveReplyId: null },
      { mid: 'm1#1', contentType: 'document', contentText: null, mediaUrl: 'https://cdn/b', interactiveReplyId: null },
    ])
  })

  it('turns a quick reply into an interactive reply', () => {
    const out = message({ text: 'Mañana 10:00', quick_reply: { payload: 'slot:1' } })
    expect(out.parts[0]).toMatchObject({ contentType: 'interactive', interactiveReplyId: 'slot:1' })
  })

  it('marks ad arrivals and unsupported messages', () => {
    const ad = message({ text: 'info', referral: { source: 'ADS', ad_id: 'ad1', ads_context_data: { ad_title: 'Black Friday' } } })
    expect(ad.parts[0].contentText).toBe('[Llegó desde el anuncio «Black Friday»] info')
    expect(ad.source).toMatchObject({ type: 'ad', id: 'ad1' })
    expect(message({ is_unsupported: true }).parts[0].contentText).toBe('[Mensaje que Instagram no permite mostrar]')
  })
})

describe('referralSource', () => {
  it('tells ads from links', () => {
    expect(referralSource({ ref: 'x', source: 'SHORTLINK' }, 't')).toEqual({ type: 'link', ref: 'x', at: 't' })
    expect(referralSource({ ad_id: '9' }, 't')).toMatchObject({ type: 'ad', id: '9' })
  })
})

describe('sent mid registry', () => {
  it('remembers our sends for ten minutes', () => {
    rememberSentMid('mid-a', 0)
    expect(wasSentByUs('mid-a', 60_000)).toBe(true)
    expect(wasSentByUs('mid-a', 11 * 60_000)).toBe(false)
    expect(wasSentByUs('mid-b', 0)).toBe(false)
  })
})

describe('withChannel', () => {
  it('labels Instagram chats in alerts', async () => {
    const { withChannel } = await import('@/lib/assignment/server')
    expect(withChannel('Fanny', 'instagram')).toBe('Fanny (Instagram)')
    expect(withChannel('Fanny', 'whatsapp')).toBe('Fanny')
    expect(withChannel('Fanny', null)).toBe('Fanny')
  })
})
