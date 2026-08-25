/**
 * Telegram Bot API helpers. Originally just outbound (050 — notify an
 * account owner of a new lead-form submission); 051 adds a second
 * outbound use (handoff alerts) and the `setWebhook`/`deleteWebhook`
 * calls that back the admin-assistant's inbound channel
 * (`/api/telegram/webhook/[accountId]`).
 *
 * Named-params shape mirrors `@/lib/whatsapp/meta-api` on purpose:
 * same codebase convention, same reason (typo in argument order
 * surfaces as a TypeScript error, not a runtime mix-up).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

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

/**
 * Best-effort Telegram alert fired when the AI hands a conversation
 * off to a human (see `auto-reply.ts` / `widget-reply.ts`, right after
 * they flip `ai_autoreply_disabled`). Loads the account's Telegram
 * config itself so callers don't need to — silently no-ops when
 * notifications aren't configured/enabled. Never throws: a failed
 * Telegram send must never affect the customer-facing reply that
 * already went out.
 */
export async function notifyOwnerOfHandoff(
  db: SupabaseClient,
  accountId: string,
  args: { contactName: string; summary: string; conversationId: string },
): Promise<void> {
  try {
    const { data: account, error } = await db
      .from('accounts')
      .select('telegram_notify_enabled, telegram_bot_token, telegram_chat_id')
      .eq('id', accountId)
      .maybeSingle()
    if (error || !account) return
    if (!account.telegram_notify_enabled || !account.telegram_bot_token || !account.telegram_chat_id) return

    await sendTelegramMessage({
      botToken: account.telegram_bot_token,
      chatId: account.telegram_chat_id,
      text: `🔔 ${args.contactName} necesita un agente humano.\n\n${args.summary}`,
    })
  } catch (err) {
    console.error('[telegram] notifyOwnerOfHandoff failed:', err)
  }
}

/**
 * Register this account's inbound webhook URL with Telegram, so
 * messages sent to its bot are POSTed to
 * `/api/telegram/webhook/[accountId]`. `secretToken` is echoed back by
 * Telegram on every update as `X-Telegram-Bot-Api-Secret-Token` — the
 * webhook route rejects anything that doesn't match
 * `accounts.telegram_webhook_secret`, so a caller who merely knows/
 * guesses an `accountId` can't feed it forged updates.
 */
export async function setTelegramWebhook(args: {
  botToken: string
  url: string
  secretToken: string
}): Promise<void> {
  const { botToken, url, secretToken } = args
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, secret_token: secretToken }),
  })
  if (!response.ok) {
    await throwTelegramError(response, `Telegram API error: ${response.status}`)
  }
}

/** Deregister the webhook — called when the admin turns the assistant
 *  off, so a stale bot token can't keep forwarding updates nobody
 *  reads. */
export async function deleteTelegramWebhook(botToken: string): Promise<void> {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/deleteWebhook`, {
    method: 'POST',
  })
  if (!response.ok) {
    await throwTelegramError(response, `Telegram API error: ${response.status}`)
  }
}
