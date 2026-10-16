import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { loadAiConfig } from '@/lib/ai/config'
import { generateOpsReply } from '@/lib/ai/ops-assistant'
import { transcribeAudio } from '@/lib/ai/audio'
import { sendTelegramChatAction, sendTelegramMessage } from '@/lib/telegram/send'
import { downloadTelegramVoice, TelegramFileError, type TelegramVoice } from '@/lib/telegram/files'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import type { ChatMessage } from '@/lib/ai/types'
import { isModuleEnabled, type EnabledModules } from '@/lib/modules'

// ============================================================
// POST /api/telegram/webhook/[accountId]
//
// Inbound side of the Telegram admin assistant (051). Telegram POSTs
// every update from the account's bot here once `setWebhook` has been
// registered (see /api/telegram/admin-chat). This endpoint is public
// by construction — Telegram calls it, not an authenticated browser
// session — so every guardrail described in the plan lives here:
//
//   1. `X-Telegram-Bot-Api-Secret-Token` must match the account's
//      stored `telegram_webhook_secret`, or the request is a no-op.
//   2. The update's `chat.id` must match `telegram_chat_id` — the one
//      chat the account owner themselves verified via "Detectar chat"
//      in Settings — or the request is a no-op. This is the actual
//      authentication: nobody who merely knows/guesses an accountId
//      or a bot token gets to talk to this assistant.
//   3. `telegram_admin_chat_enabled` must be on.
//
// The owner can write or send a voice note (feature module
// `telegram_voice`): it is transcribed with Whisper on the system's
// OpenAI key (`config.transcriptionApiKey`: embeddings key, else the
// OpenAI chat key, the account's or the platform's) and the
// reply quotes what was understood. With `telegram_agenda` on, the
// assistant can also book, move and cancel appointments.
//
// Every failure mode above (bad secret, unknown account, disabled,
// wrong chat) responds 200 with no body and no further action —
// never 404/403 — so a caller probing this endpoint can't learn which
// accountIds are valid. The whole handler also never throws: a bug
// here must not turn into Telegram retrying the same update forever.
// ============================================================

const MAX_MESSAGE_LENGTH = 2000

interface TelegramUpdate {
  message?: {
    chat?: { id?: number | string }
    text?: string
    caption?: string
    voice?: TelegramVoice
    audio?: TelegramVoice
  }
}

const VOICE_OFF = 'Las notas de voz no están activadas para esta cuenta. Escríbeme el mensaje, por favor.'
const VOICE_NO_KEY = 'No puedo escuchar notas de voz porque no hay una clave de OpenAI configurada para transcribirlas. Escríbeme el mensaje, por favor.'
const VOICE_TOO_LONG = 'La nota de voz es muy larga (máximo 5 minutos). Envíame una más corta o escríbeme.'
const VOICE_FAILED = 'No pude escuchar esa nota de voz. Inténtalo de nuevo o escríbeme el mensaje.'
const VOICE_EMPTY = 'No entendí nada en esa nota de voz. ¿Me la repites o me lo escribes?'

function ok(): NextResponse {
  return new NextResponse(null, { status: 200 })
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> },
): Promise<NextResponse> {
  const { accountId } = await params

  try {
    const secretHeader = request.headers.get('x-telegram-bot-api-secret-token')
    if (!secretHeader) return ok()

    const db = supabaseAdmin()
    const { data: account, error } = await db
      .from('accounts')
      .select('telegram_admin_chat_enabled, telegram_webhook_secret, telegram_bot_token, telegram_chat_id, enabled_modules')
      .eq('id', accountId)
      .maybeSingle()
    if (error || !account) return ok()
    if (!account.telegram_admin_chat_enabled) return ok()
    if (!isModuleEnabled(account.enabled_modules as EnabledModules | null, 'telegram')) return ok()
    if (!account.telegram_webhook_secret || account.telegram_webhook_secret !== secretHeader) return ok()
    if (!account.telegram_bot_token || !account.telegram_chat_id) return ok()

    let update: TelegramUpdate
    try {
      update = await request.json()
    } catch {
      return ok()
    }

    const chatId = update.message?.chat?.id
    if (chatId == null || String(chatId) !== String(account.telegram_chat_id)) return ok()

    const message = update.message ?? {}
    const typed = typeof message.text === 'string' ? message.text.trim() : typeof message.caption === 'string' ? message.caption.trim() : ''
    const voice = !typed ? (message.voice ?? message.audio) : undefined
    if (!typed && !voice?.file_id) return ok()

    const botToken = account.telegram_bot_token
    const chatIdStr = account.telegram_chat_id
    const modules = account.enabled_modules as EnabledModules | null

    if (voice && !isModuleEnabled(modules, 'telegram_voice')) {
      await sendTelegramMessage({ botToken, chatId: chatIdStr, text: VOICE_OFF })
      return ok()
    }

    const limit = checkRateLimit(`telegram-admin:${accountId}`, RATE_LIMITS.telegramAdminChat)
    if (!limit.success) {
      await sendTelegramMessage({ botToken, chatId: chatIdStr, text: '⏳ Muchas preguntas seguidas — espera un momento y vuelve a intentarlo.' })
      return ok()
    }

    const config = await loadAiConfig(db, accountId)
    if (!config) {
      await sendTelegramMessage({
        botToken,
        chatId: chatIdStr,
        text: 'El asistente de IA no está configurado para esta cuenta todavía.',
      })
      return ok()
    }

    await sendTelegramChatAction({ botToken, chatId: chatIdStr, action: 'typing' })

    let text = typed
    if (voice) {
      const voiceKey = config.transcriptionApiKey ?? config.embeddingsApiKey
      if (!voiceKey) {
        await sendTelegramMessage({ botToken, chatId: chatIdStr, text: VOICE_NO_KEY })
        return ok()
      }
      try {
        const audio = await downloadTelegramVoice(botToken, voice)
        text = (await transcribeAudio(voiceKey, audio)).trim()
      } catch (err) {
        console.error('[telegram admin webhook] voice note failed:', err)
        const tooLong = err instanceof TelegramFileError && err.code !== 'download_failed'
        await sendTelegramMessage({ botToken, chatId: chatIdStr, text: tooLong ? VOICE_TOO_LONG : VOICE_FAILED })
        return ok()
      }
      if (!text) {
        await sendTelegramMessage({ botToken, chatId: chatIdStr, text: VOICE_EMPTY })
        return ok()
      }
    }

    const truncated = text.slice(0, MAX_MESSAGE_LENGTH)

    const { data: pastTurns } = await db
      .from('telegram_admin_turns')
      .select('role, content')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(20)
    const history: ChatMessage[] = (pastTurns ?? [])
      .slice()
      .reverse()
      .map((t: { role: string; content: string }) => ({ role: t.role as 'user' | 'assistant', content: t.content }))

    let replyText: string
    try {
      const result = await generateOpsReply({
        db,
        accountId,
        config,
        history,
        userMessage: truncated,
        agenda: isModuleEnabled(modules, 'telegram_agenda'),
      })
      replyText = result.text
    } catch (err) {
      console.error('[telegram admin webhook] generateOpsReply failed:', err)
      await sendTelegramMessage({
        botToken,
        chatId: chatIdStr,
        text: 'No pude procesar esa consulta en este momento. Intenta de nuevo en un rato.',
      })
      return ok()
    }

    await db.from('telegram_admin_turns').insert([
      { account_id: accountId, role: 'user', content: truncated },
      { account_id: accountId, role: 'assistant', content: replyText },
    ])

    // Quote what a voice note was understood as, so a misheard day or
    // time is easy to spot.
    const shown = voice ? `🎤 «${truncated}»\n\n${replyText}` : replyText
    await sendTelegramMessage({ botToken, chatId: chatIdStr, text: shown })
    return ok()
  } catch (err) {
    console.error('[telegram admin webhook] failed:', err)
    return ok()
  }
}
