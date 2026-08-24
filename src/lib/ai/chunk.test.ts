import { describe, it, expect } from 'vitest'
import { chunkText } from './chunk'

describe('chunkText', () => {
  it('returns nothing for empty / whitespace input', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n\n  ')).toEqual([])
  })

  it('keeps a short document as a single chunk', () => {
    expect(chunkText('Hello world')).toEqual(['Hello world'])
  })

  it('packs multiple paragraphs up to the char budget', () => {
    const a = 'A'.repeat(400)
    const b = 'B'.repeat(400)
    const c = 'C'.repeat(400)
    // 400 + 2 + 400 = 802 <= 900, but adding c would exceed → new chunk.
    const out = chunkText(`${a}\n\n${b}\n\n${c}`, { maxChars: 900 })
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(`${a}\n\n${b}`)
    expect(out[1]).toBe(c)
  })

  it('hard-splits a paragraph larger than the budget', () => {
    const big = 'x'.repeat(2500)
    const out = chunkText(big, { maxChars: 1000 })
    expect(out).toHaveLength(3)
    expect(out.every((c) => c.length <= 1000)).toBe(true)
    expect(out.join('')).toBe(big)
  })

  it('collapses extra blank lines without emitting an empty chunk', () => {
    // Two short paragraphs pack into one chunk; the extra blank lines
    // must not produce an empty paragraph/chunk.
    const out = chunkText('one\n\n\n\ntwo')
    expect(out).toEqual(['one\n\ntwo'])
  })

  it('does not overlap by default', () => {
    const a = 'A'.repeat(400)
    const b = 'B'.repeat(400)
    const c = 'C'.repeat(400)
    const out = chunkText(`${a}\n\n${b}\n\n${c}`, { maxChars: 900 })
    expect(out[1]).toBe(c)
  })

  it('stitches the tail of the previous chunk on when overlapChars is set', () => {
    const a = 'A'.repeat(400)
    const b = 'B'.repeat(400)
    const c = 'C'.repeat(400)
    const out = chunkText(`${a}\n\n${b}\n\n${c}`, { maxChars: 900, overlapChars: 50 })
    expect(out).toHaveLength(2)
    // First chunk is untouched — nothing precedes it.
    expect(out[0]).toBe(`${a}\n\n${b}`)
    // Second chunk is prefixed with the last 50 chars of the first.
    expect(out[1]).toBe(`${'B'.repeat(50)}\n\n${c}`)
  })

  it('applies overlap across a hard split too', () => {
    const big = 'x'.repeat(2500)
    const out = chunkText(big, { maxChars: 1000, overlapChars: 100 })
    expect(out).toHaveLength(3)
    expect(out[0]).toBe('x'.repeat(1000))
    expect(out[1].startsWith('x'.repeat(100))).toBe(true)
  })

  it('overlapChars <= 0 is a no-op', () => {
    const out = chunkText('one\n\ntwo', { overlapChars: 0 })
    expect(out).toEqual(['one\n\ntwo'])
  })
})
