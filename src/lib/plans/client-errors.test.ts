import { describe, it, expect } from 'vitest'

import { planErrorFromBody, planErrorFromDb } from './client-errors'

describe('planErrorFromBody', () => {
  it('reads a suspended refusal', () => {
    expect(planErrorFromBody({ code: 'plan_suspended' })).toEqual({ key: 'suspended' })
  })

  it('reads a limit refusal', () => {
    expect(planErrorFromBody({ code: 'plan_limit', resource: 'users', used: 3, limit: 3 })).toEqual({
      key: 'limitReached',
      resource: 'users',
      used: 3,
      limit: 3,
    })
  })

  it('ignores other errors', () => {
    expect(planErrorFromBody({ error: 'boom' })).toBeNull()
    expect(planErrorFromBody({ code: 'plan_limit', resource: 'gold' })).toBeNull()
    expect(planErrorFromBody(null)).toBeNull()
  })
})

describe('planErrorFromDb', () => {
  it('reads the contacts trigger error and its detail', () => {
    expect(planErrorFromDb({ message: 'plan_limit:contacts', details: '500/500' })).toEqual({
      key: 'limitReached',
      resource: 'contacts',
      used: 500,
      limit: 500,
    })
  })

  it('copes with a missing detail', () => {
    expect(planErrorFromDb({ message: 'plan_limit:contacts' })).toMatchObject({ limit: null })
  })

  it('ignores other database errors', () => {
    expect(planErrorFromDb({ message: 'duplicate key value' })).toBeNull()
    expect(planErrorFromDb(null)).toBeNull()
  })
})
