import { describe, expect, it } from 'vitest'
import { reminderContactName } from './drain-reminders'

describe('reminderContactName', () => {
  it('keeps a real name', () => {
    expect(reminderContactName(' Ana Pérez ')).toBe('Ana Pérez')
  })
  it('drops an Instagram handle and blanks', () => {
    expect(reminderContactName('@ana.perez')).toBeUndefined()
    expect(reminderContactName('')).toBeUndefined()
    expect(reminderContactName(null)).toBeUndefined()
  })
})
