import { describe, it, expect } from 'vitest'
import { parseNote, parseCustomField, parseLeadStage, parseSentiment } from './shared'

describe('parseNote', () => {
  it('accepts a short trimmed note', () => {
    expect(parseNote({ text: '  Likes the blue variant  ' })).toEqual({
      text: 'Likes the blue variant',
    })
  })

  it('rejects a missing/empty text', () => {
    expect(parseNote({})).toEqual({ error: 'text is required.' })
    expect(parseNote({ text: '   ' })).toEqual({ error: 'text is required.' })
  })

  it('rejects a note over 1000 characters', () => {
    const result = parseNote({ text: 'x'.repeat(1001) })
    expect(result).toEqual({ error: 'text must be 1000 characters or fewer.' })
  })
})

describe('parseCustomField', () => {
  const allowed = ['Budget', 'Preferred contact time']

  it('accepts a known field with a value', () => {
    expect(parseCustomField({ field: 'Budget', value: '$500' }, allowed)).toEqual({
      field: 'Budget',
      value: '$500',
    })
  })

  it('rejects a field not in the allowed list', () => {
    const result = parseCustomField({ field: 'Not A Field', value: 'x' }, allowed)
    expect(result).toEqual({
      error: 'field must be one of: Budget, Preferred contact time.',
    })
  })

  it('rejects a missing value', () => {
    expect(parseCustomField({ field: 'Budget', value: '' }, allowed)).toEqual({
      error: 'value is required.',
    })
  })

  it('rejects a value over 500 characters', () => {
    const result = parseCustomField({ field: 'Budget', value: 'x'.repeat(501) }, allowed)
    expect(result).toEqual({ error: 'value must be 500 characters or fewer.' })
  })
})

describe('parseLeadStage', () => {
  const allowed = ['New', 'Qualified', 'Won']

  it('accepts a known stage', () => {
    expect(parseLeadStage({ stage: 'Qualified' }, allowed)).toEqual({ stage: 'Qualified' })
  })

  it('rejects an unknown stage', () => {
    expect(parseLeadStage({ stage: 'Nope' }, allowed)).toEqual({
      error: 'stage must be one of: New, Qualified, Won.',
    })
  })

  it('rejects a missing stage', () => {
    expect(parseLeadStage({}, allowed)).toEqual({
      error: 'stage must be one of: New, Qualified, Won.',
    })
  })
})

describe('parseSentiment', () => {
  it('accepts each valid sentiment', () => {
    expect(parseSentiment({ sentiment: 'positive' })).toEqual({ sentiment: 'positive' })
    expect(parseSentiment({ sentiment: 'neutral' })).toEqual({ sentiment: 'neutral' })
    expect(parseSentiment({ sentiment: 'negative' })).toEqual({ sentiment: 'negative' })
  })

  it('rejects an invalid sentiment', () => {
    expect(parseSentiment({ sentiment: 'furious' })).toEqual({
      error: 'sentiment must be one of: positive, neutral, negative.',
    })
  })

  it('rejects a missing sentiment', () => {
    expect(parseSentiment({})).toEqual({
      error: 'sentiment must be one of: positive, neutral, negative.',
    })
  })
})
