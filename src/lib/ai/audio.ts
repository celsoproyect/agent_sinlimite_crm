import { AiError } from './types'
import { aiRequestTimeoutMs } from './defaults'
import { providerHttpError, toNetworkError } from './providers/shared'

// ============================================================
// Audio transcription (OpenAI Whisper).
//
// Reuses the account's embeddings key — same "auxiliary OpenAI key"
// precedent as embeddings.ts. No key configured means no transcription;
// callers degrade to a text placeholder instead of failing the reply.
// ============================================================

const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions'
const TRANSCRIPTION_MODEL = 'whisper-1'

interface TranscriptionResponse {
  text?: string
}

/**
 * Transcribe a voice note's raw bytes to text. Whisper's endpoint takes a
 * multipart file upload, not a URL — callers must resolve the audio to a
 * Buffer first (public bucket URL: plain fetch; proxy pointer: `getMediaUrl`
 * + `downloadMedia`).
 */
export async function transcribeAudio(
  apiKey: string,
  audio: { buffer: Buffer; contentType: string },
): Promise<string> {
  const timeoutMs = aiRequestTimeoutMs()
  const form = new FormData()
  form.append('model', TRANSCRIPTION_MODEL)
  form.append(
    'file',
    new Blob([new Uint8Array(audio.buffer)], { type: audio.contentType }),
    'voice-note.ogg',
  )

  let res: Response
  try {
    res = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    throw await providerHttpError('OpenAI transcription', res)
  }

  const data = (await res.json().catch(() => null)) as TranscriptionResponse | null
  if (typeof data?.text !== 'string') {
    throw new AiError('Transcription response was malformed.', {
      code: 'transcription_malformed',
    })
  }
  return data.text
}
