import { afterEach, describe, expect, it, vi } from 'vitest'

import { getLatestTelegramChat, sendTelegramMessage } from './send'

const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

afterEach(() => {
  fetchMock.mockReset()
})

describe('sendTelegramMessage', () => {
  it('posts to the bot sendMessage endpoint with chat_id and text', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })

    await sendTelegramMessage({ botToken: 'tok-1', chatId: 'chat-1', text: 'hello' })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.telegram.org/bottok-1/sendMessage')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ chat_id: 'chat-1', text: 'hello' })
  })

  it('throws with Telegram\'s error description when the call fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ ok: false, description: 'chat not found' }),
    })

    await expect(
      sendTelegramMessage({ botToken: 'tok-1', chatId: 'bad', text: 'hi' }),
    ).rejects.toThrow('chat not found')
  })

  it('falls back to a generic message when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json')
      },
    })

    await expect(
      sendTelegramMessage({ botToken: 'tok-1', chatId: 'chat-1', text: 'hi' }),
    ).rejects.toThrow('Telegram API error: 500')
  })
})

describe('getLatestTelegramChat', () => {
  it('returns null when the bot has no updates', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: [] }) })

    const chat = await getLatestTelegramChat('tok-1')
    expect(chat).toBeNull()
  })

  it('returns the most recent chat, preferring a group title', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        result: [
          { message: { chat: { id: 111, first_name: 'Old' } } },
          { message: { chat: { id: 222, title: 'Sales Group' } } },
        ],
      }),
    })

    const chat = await getLatestTelegramChat('tok-1')
    expect(chat).toEqual({ chatId: '222', name: 'Sales Group' })
  })

  it('falls back to first/last name, then @username, then the id', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        result: [{ message: { chat: { id: 1, first_name: 'Jane', last_name: 'Doe' } } }],
      }),
    })
    expect(await getLatestTelegramChat('tok-1')).toEqual({ chatId: '1', name: 'Jane Doe' })

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        result: [{ message: { chat: { id: 2, username: 'janedoe' } } }],
      }),
    })
    expect(await getLatestTelegramChat('tok-1')).toEqual({ chatId: '2', name: '@janedoe' })

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ok: true,
        result: [{ message: { chat: { id: 3 } } }],
      }),
    })
    expect(await getLatestTelegramChat('tok-1')).toEqual({ chatId: '3', name: '3' })
  })

  it('throws when the getUpdates call itself fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ ok: false, description: 'Unauthorized' }),
    })

    await expect(getLatestTelegramChat('bad-token')).rejects.toThrow('Unauthorized')
  })
})
