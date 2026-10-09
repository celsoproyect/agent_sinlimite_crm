import { describe, it, expect } from 'vitest'
import type { AccountMember } from '@/types'

import { teamProfiles } from './members'

const member = (user_id: string) => ({ user_id }) as AccountMember

describe('teamProfiles', () => {
  const profiles = [{ user_id: 'owner' }, { user_id: 'super' }]

  it('keeps only profiles the members API lists (hides support visitors)', () => {
    expect(teamProfiles(profiles, [member('owner')])).toEqual([{ user_id: 'owner' }])
  })

  it('passes everything through when the members list is empty', () => {
    expect(teamProfiles(profiles, [])).toEqual(profiles)
  })
})
