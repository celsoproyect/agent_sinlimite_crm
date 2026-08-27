import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadSendableContact, sendToContact } from './meta-send'

describe('loadSendableContact', () => {
  function stubDb(row: Record<string, unknown> | null): SupabaseClient {
    const updateCalls: Record<string, unknown>[] = []
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: () => Promise.resolve({ data: row, error: null }),
      update: (payload: Record<string, unknown>) => {
        updateCalls.push(payload)
        return builder
      },
    }
    return { from: () => builder } as unknown as SupabaseClient
  }

  it('resolves by phone when it is a valid E.164 number', async () => {
    const db = stubDb({ id: 'c1', phone: '+1 555-123-4567', whatsapp_user_id: null })
    const contact = await loadSendableContact(db, 'c1', 'acct')
    expect(contact).toEqual({ id: 'c1', recipient: '15551234567', isBsuid: false })
  })

  it('falls back to the BSUID when phone is empty', async () => {
    const db = stubDb({ id: 'c2', phone: '', whatsapp_user_id: 'DO.123' })
    const contact = await loadSendableContact(db, 'c2', 'acct')
    expect(contact).toEqual({ id: 'c2', recipient: 'DO.123', isBsuid: true })
  })

  it('falls back to the BSUID when phone is present but invalid', async () => {
    const db = stubDb({ id: 'c3', phone: 'not-a-phone', whatsapp_user_id: 'DO.456' })
    const contact = await loadSendableContact(db, 'c3', 'acct')
    expect(contact).toEqual({ id: 'c3', recipient: 'DO.456', isBsuid: true })
  })

  it('throws when phone is invalid and there is no BSUID', async () => {
    const db = stubDb({ id: 'c4', phone: 'not-a-phone', whatsapp_user_id: null })
    await expect(loadSendableContact(db, 'c4', 'acct')).rejects.toThrow('contact phone invalid')
  })

  it('throws when neither phone nor BSUID is present', async () => {
    const db = stubDb({ id: 'c5', phone: '', whatsapp_user_id: null })
    await expect(loadSendableContact(db, 'c5', 'acct')).rejects.toThrow(
      'contact not found for this account',
    )
  })

  it('throws when the row does not exist', async () => {
    const db = stubDb(null)
    await expect(loadSendableContact(db, 'missing', 'acct')).rejects.toThrow(
      'contact not found for this account',
    )
  })
})

describe('sendToContact', () => {
  function stubDb() {
    const updateCalls: { id: string; payload: Record<string, unknown> }[] = []
    const db = {
      from: () => ({
        update: (payload: Record<string, unknown>) => ({
          eq: (_col: string, id: string) => {
            updateCalls.push({ id, payload })
            return Promise.resolve({ error: null })
          },
        }),
      }),
    } as unknown as SupabaseClient
    return { db, updateCalls }
  }

  it('sends once and does not retry variants for a BSUID recipient', async () => {
    const { db, updateCalls } = stubDb()
    const send = vi.fn(async (to: string) => `wamid-${to}`)
    const result = await sendToContact(
      db,
      { id: 'c1', recipient: 'DO.123', isBsuid: true },
      send,
    )
    expect(result).toBe('wamid-DO.123')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('DO.123')
    expect(updateCalls).toHaveLength(0)
  })

  it('propagates a BSUID send failure without retrying', async () => {
    const { db } = stubDb()
    const send = vi.fn(async () => {
      throw new Error('recipient not allowed')
    })
    await expect(
      sendToContact(db, { id: 'c1', recipient: 'DO.123', isBsuid: true }, send),
    ).rejects.toThrow('recipient not allowed')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('retries phone variants and persists the working one', async () => {
    // "+370 063 949 836" domestically → the trunk-0-inserted variant is
    // what Meta actually has registered; the plain sanitized original
    // fails first (mirrors the scenario in phoneVariants' own docstring).
    const { db, updateCalls } = stubDb()
    const send = vi.fn(async (to: string) => {
      if (to !== '370063949836') {
        throw new Error('(#131030) Recipient phone number not in allowed list')
      }
      return 'wamid-ok'
    })
    const result = await sendToContact(
      db,
      { id: 'c1', recipient: '37063949836', isBsuid: false },
      send,
    )
    expect(result).toBe('wamid-ok')
    expect(send.mock.calls.length).toBeGreaterThan(1)
    expect(updateCalls).toEqual([{ id: 'c1', payload: { phone: '370063949836' } }])
  })
})
