import { describe, expect, it } from 'vitest'
import {
  renderReminderMessage,
  reminderTemplateParams,
  isOutsideSessionWindowError,
} from './reminder-message'

describe('renderReminderMessage', () => {
  it('substitutes all known placeholders', () => {
    const out = renderReminderMessage(
      'Hola {{contact_name}}, te esperamos el {{date}} a las {{time}} para {{service}}.',
      { contactName: 'Ana', service: 'Corte de cabello', startsAt: '2026-08-25T14:30:00.000Z' },
    )
    expect(out).toBe('Hola Ana, te esperamos el 2026-08-25 a las 14:30 para Corte de cabello.')
  })

  it('leaves an unrecognized token visible', () => {
    const out = renderReminderMessage('Hola {{unknown_token}}', {
      contactName: 'Ana',
      service: 'Corte',
      startsAt: '2026-08-25T14:30:00.000Z',
    })
    expect(out).toBe('Hola {{unknown_token}}')
  })

  it('tolerates missing/empty starts_at gracefully', () => {
    const out = renderReminderMessage('{{date}} {{time}}', {
      contactName: 'Ana',
      service: 'Corte',
      startsAt: 'not-a-date',
    })
    expect(out).toBe('not-a-date ')
  })
})

describe('reminderTemplateParams', () => {
  it('returns positional params in the documented order', () => {
    const params = reminderTemplateParams({
      contactName: 'Ana',
      service: 'Corte de cabello',
      startsAt: '2026-08-25T14:30:00.000Z',
    })
    expect(params).toEqual(['Ana', 'Corte de cabello', '2026-08-25', '14:30'])
  })
})

describe('isOutsideSessionWindowError', () => {
  it('matches the Meta re-engagement error code', () => {
    expect(isOutsideSessionWindowError('(#131047) Message failed to send because more than 24 hours have passed since the customer last replied to this number.')).toBe(true)
  })

  it('does not match unrelated errors', () => {
    expect(isOutsideSessionWindowError('WhatsApp not configured')).toBe(false)
    expect(isOutsideSessionWindowError('contact not found for this account')).toBe(false)
  })
})
