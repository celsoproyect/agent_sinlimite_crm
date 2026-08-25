/**
 * Telegram Bot API helpers, used to notify an account owner of a new
 * lead-form submission (050). Kept intentionally tiny — this is a
 * notification channel, not a conversational one, so there's no
 * inbound handling here.
 *
 * Named-params shape mirrors `@/lib/whatsapp/meta-api` on purpose:
 * same codebase convention, same reason (typo in argument order
 * surfaces as a TypeScript error, not a runtime mix-up).
 */

const TELEGRAM_API_BASE = 'https://api.telegram.org'

interface TelegramErrorResponse {
  ok: false
  description?: string
}

async function throwTelegramError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as TelegramErrorResponse
    if (data.description) message = data.description
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

export interface SendTelegramMessageArgs {
  botToken: string
  chatId: string
  text: string
}

/**
 * Send a plain-text Telegram message. Unlike WhatsApp, Telegram has
 * no 24-hour re-engagement window: once `chatId` has messaged the
 * bot at least once (see `getLatestTelegramChat`), the bot can
 * message that chat at any time.
 */
export async function sendTelegramMessage(args: SendTelegramMessageArgs): Promise<void> {
  const { botToken, chatId, text } = args
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  if (!response.ok) {
    await throwTelegramError(response, `Telegram API error: ${response.status}`)
  }
}

export interface TelegramChatCandidate {
  chatId: string
  /** Best available label — group title, full name, or @username. */
  name: string
}

/**
 * Find the most recent chat that has messaged this bot, via Telegram's
 * `getUpdates` long-poll endpoint (used here as a one-shot lookup, not
 * a poll loop). Backs the settings UI's "Detect chat" button: the
 * account owner opens their bot in Telegram, sends any message (e.g.
 * "hi"), then clicks the button — no manual chat-id lookup needed.
 *
 * Returns null when the bot has never received a message.
 */
export async function getLatestTelegramChat(botToken: string): Promise<TelegramChatCandidate | null> {
  const url = `${TELEGRAM_API_BASE}/bot${botToken}/getUpdates?limit=100`
  const response = await fetch(url)
  if (!response.ok) {
    await throwTelegramError(response, `Telegram API error: ${response.status}`)
  }
  const data = await response.json()
  const updates = Array.isArray(data.result) ? data.result : []

  for (let i = updates.length - 1; i >= 0; i--) {
    const chat = updates[i]?.message?.chat
    if (chat?.id == null) continue
    const name =
      chat.title ||
      [chat.first_name, chat.last_name].filter(Boolean).join(' ') ||
      (chat.username ? `@${chat.username}` : String(chat.id))
    return { chatId: String(chat.id), name }
  }
  return null
}
