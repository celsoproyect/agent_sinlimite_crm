import { describe, expect, it } from 'vitest'
import {
  renderReminderMessage,
  reminderTemplateParams,
  isOutsideSessionWindowError,
} from './reminder-message'

describe('renderReminderMessage', () => {
  it('substitutes all known placeholders, converting UTC to America/Santo_Domingo', () => {
    // 14:30 UTC - 4h (Santo Domingo, no DST) = 10:30 local.
    const out = renderReminderMessage(
      'Hola {{contact_name}}, te esperamos el {{date}} a las {{time}} para {{service}}.',
      { contactName: 'Ana', service: 'Corte de cabello', startsAt: '2026-08-25T14:30:00.000Z' },
    )
    expect(out).toBe('Hola Ana, te esperamos el 2026-08-25 a las 10:30 para Corte de cabello.')
  })

  it('rolls the date back a day when the UTC instant is after 20:00 Santo Domingo-local', () => {
    // 02:00 UTC on the 26th - 4h = 22:00 local on the 25th.
    const out = renderReminderMessage('{{date}} {{time}}', {
      contactName: 'Ana',
      service: 'Corte',
      startsAt: '2026-08-26T02:00:00.000Z',
    })
    expect(out).toBe('2026-08-25 22:00')
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
  it('returns positional params in the documented order, converted to America/Santo_Domingo', () => {
    const params = reminderTemplateParams({
      contactName: 'Ana',
      service: 'Corte de cabello',
      startsAt: '2026-08-25T14:30:00.000Z',
    })
    expect(params).toEqual(['Ana', 'Corte de cabello', '2026-08-25', '10:30'])
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
