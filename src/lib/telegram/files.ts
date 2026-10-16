// ============================================================
// Downloading files the owner sends to their Telegram bot (voice notes
// for the ops assistant). Bot API: getFile → file_path, then
// /file/bot<token>/<file_path>. Bots can only download up to 20 MB.
// ============================================================

const TELEGRAM_API_BASE = 'https://api.telegram.org'

/** Longest voice note the assistant transcribes, in seconds. */
export const MAX_VOICE_SECONDS = 300
/** Largest file it downloads (Bot API limit is 20 MB). */
export const MAX_VOICE_BYTES = 20 * 1024 * 1024

export interface TelegramVoice {
  file_id?: string
  duration?: number
  mime_type?: string
  file_size?: number
}

export class TelegramFileError extends Error {
  constructor(
    message: string,
    readonly code: 'too_long' | 'too_large' | 'download_failed',
  ) {
    super(message)
  }
}

/** Download a voice note / audio file. Throws TelegramFileError. */
export async function downloadTelegramVoice(
  botToken: string,
  voice: TelegramVoice,
): Promise<{ buffer: Buffer; contentType: string }> {
  if (!voice.file_id) throw new TelegramFileError('no file id', 'download_failed')
  if ((voice.duration ?? 0) > MAX_VOICE_SECONDS) throw new TelegramFileError('voice note too long', 'too_long')
  if ((voice.file_size ?? 0) > MAX_VOICE_BYTES) throw new TelegramFileError('file too large', 'too_large')

  const meta = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/getFile?file_id=${encodeURIComponent(voice.file_id)}`)
  const json = (await meta.json().catch(() => null)) as { ok?: boolean; result?: { file_path?: string; file_size?: number } } | null
  const path = json?.ok ? json.result?.file_path : undefined
  if (!meta.ok || !path) throw new TelegramFileError('getFile failed', 'download_failed')
  if ((json?.result?.file_size ?? 0) > MAX_VOICE_BYTES) throw new TelegramFileError('file too large', 'too_large')

  const file = await fetch(`${TELEGRAM_API_BASE}/file/bot${botToken}/${path}`)
  if (!file.ok) throw new TelegramFileError('download failed', 'download_failed')
  const buffer = Buffer.from(await file.arrayBuffer())
  if (buffer.length > MAX_VOICE_BYTES) throw new TelegramFileError('file too large', 'too_large')
  return { buffer, contentType: voice.mime_type || 'audio/ogg' }
}
