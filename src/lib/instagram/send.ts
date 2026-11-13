import type { SupabaseClient } from '@supabase/supabase-js'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import type { InteractiveButton, InteractiveListSection, MediaKind } from '@/lib/whatsapp/meta-api'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import type { MessageMetadata } from '@/types'
import {
  sendInstagramMessage,
  sendInstagramSenderAction,
  type InstagramAttachmentType,
  type InstagramOutbound,
} from './api'
import { loadInstagramConnection, type InstagramConnection } from './connection'
import { splitInstagramText, toInstagramText } from './format'

// ============================================================
// Outbound Instagram DMs. The WhatsApp engine senders
// (flows/meta-send.ts) and the inbox send core hand off here when the
// conversation's channel is 'instagram', so the AI agent, flows and
// automations reach Instagram customers through the same calls.
// ============================================================

// Every message id we send, for a few minutes. Meta echoes each of our
// own sends back to the webhook (`is_echo`), sometimes before our insert
// lands; this tells those apart from replies the owner typed in the
// Instagram app. In-process, like the reply-delay timers: fine for the
// single-instance deployment.
const SENT_TTL_MS = 10 * 60 * 1000
const sentMids = new Map<string, number>()

export function rememberSentMid(mid: string, now: number = Date.now()): void {
  if (!mid) return
  sentMids.set(mid, now)
  if (sentMids.size > 2000) {
    for (const [key, at] of sentMids) if (now - at > SENT_TTL_MS) sentMids.delete(key)
  }
}

export function wasSentByUs(mid: string, now: number = Date.now()): boolean {
  const at = sentMids.get(mid)
  return at != null && now - at <= SENT_TTL_MS
}

/** The conversation's channel ('whatsapp' when unknown). */
export async function conversationChannel(db: SupabaseClient, conversationId: string): Promise<string> {
  const { data } = await db.from('conversations').select('channel').eq('id', conversationId).maybeSingle()
  return (data?.channel as string | undefined) ?? 'whatsapp'
}

export class InstagramSendError extends Error {
  constructor(
    message: string,
    readonly code: 'not_connected' | 'no_recipient' | 'window_closed' | 'meta_error',
  ) {
    super(message)
    this.name = 'InstagramSendError'
  }
}

export interface InstagramRecipient {
  conn: InstagramConnection
  igsid: string
}

export async function loadInstagramRecipient(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
): Promise<InstagramRecipient> {
  // The connection holds the token, so its table is service-role only
  // (RLS without policies): a user-scoped client (the inbox send) would
  // read nothing. The caller has already scoped the account.
  const conn = await loadInstagramConnection(supabaseAdmin(), accountId)
  if (!conn) throw new InstagramSendError('Instagram no está conectado en esta cuenta', 'not_connected')
  const { data: contact } = await db
    .from('contacts')
    .select('instagram_id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  const igsid = contact?.instagram_id as string | undefined
  if (!igsid) throw new InstagramSendError('El contacto no tiene una cuenta de Instagram', 'no_recipient')
  return { conn, igsid }
}

/** Meta's "outside the allowed window" (the 24-hour rule). */
function isWindowError(err: unknown): boolean {
  const e = err as { code?: number; subcode?: number; message?: string }
  return e?.subcode === 2534022 || e?.code === 10 || /outside of allowed window/i.test(e?.message ?? '')
}

async function deliver(to: InstagramRecipient, message: InstagramOutbound): Promise<string> {
  try {
    const mid = await sendInstagramMessage(to.conn.accessToken, { id: to.igsid }, message)
    rememberSentMid(mid)
    return mid
  } catch (err) {
    if (isWindowError(err)) {
      throw new InstagramSendError(
        'Pasaron más de 24 horas desde el último mensaje del cliente; Instagram no permite escribirle hasta que vuelva a escribir.',
        'window_closed',
      )
    }
    throw new InstagramSendError(err instanceof Error ? err.message : String(err), 'meta_error')
  }
}

/** Sends a (possibly long) text as one or more DMs; the last one carries the quick replies. */
export async function deliverInstagramText(
  to: InstagramRecipient,
  text: string,
  quickReplies?: { title: string; payload: string }[],
): Promise<string[]> {
  const parts = splitInstagramText(toInstagramText(text))
  if (parts.length === 0) return []
  const mids: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1
    mids.push(await deliver(to, { kind: 'text', text: parts[i], quickReplies: last ? quickReplies : undefined }))
  }
  return mids
}

export function instagramAttachmentType(kind: MediaKind): InstagramAttachmentType {
  return kind === 'document' ? 'file' : kind
}

/** Media first, then its caption as a text (Instagram attachments carry none). */
export async function deliverInstagramMedia(
  to: InstagramRecipient,
  kind: MediaKind,
  url: string,
  caption?: string | null,
): Promise<{ mediaMid: string; captionMids: string[] }> {
  const mediaMid = await deliver(to, { kind: 'attachment', type: instagramAttachmentType(kind), url })
  const captionMids = caption?.trim() ? await deliverInstagramText(to, caption) : []
  return { mediaMid, captionMids }
}

async function persistBotMessage(
  db: SupabaseClient,
  conversationId: string,
  row: Record<string, unknown>,
  preview: string,
): Promise<void> {
  const { error } = await db.from('messages').insert({
    conversation_id: conversationId,
    sender_type: 'bot',
    status: 'sent',
    ...row,
  })
  if (error) throw new Error(`sent to Instagram but DB insert failed: ${error.message}`)
  const now = new Date().toISOString()
  await db
    .from('conversations')
    .update({ last_message_text: preview, last_message_at: now, updated_at: now })
    .eq('id', conversationId)
}

interface EngineBase {
  accountId: string
  conversationId: string
  contactId: string
  aiGenerated?: boolean
}

export async function instagramEngineSendText(args: EngineBase & { text: string }): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()
  const to = await loadInstagramRecipient(db, args.accountId, args.contactId)
  const mids = await deliverInstagramText(to, args.text)
  const text = toInstagramText(args.text)
  await persistBotMessage(
    db,
    args.conversationId,
    { content_type: 'text', content_text: text, message_id: mids[0] ?? null, ai_generated: args.aiGenerated ?? false },
    text,
  )
  return { whatsapp_message_id: mids[0] ?? '' }
}

export async function instagramEngineSendMedia(
  args: EngineBase & { kind: MediaKind; link: string; caption?: string; metadata?: MessageMetadata },
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()
  const to = await loadInstagramRecipient(db, args.accountId, args.contactId)
  const { mediaMid } = await deliverInstagramMedia(to, args.kind, args.link, args.caption)
  const caption = args.caption ? toInstagramText(args.caption) : null
  await persistBotMessage(
    db,
    args.conversationId,
    {
      content_type: args.kind,
      content_text: caption,
      media_url: args.link,
      message_id: mediaMid,
      metadata: args.metadata ?? null,
      ai_generated: args.aiGenerated ?? false,
    },
    caption || `[${args.kind}]`,
  )
  return { whatsapp_message_id: mediaMid }
}

/**
 * WhatsApp buttons and list rows become Instagram quick replies (up to
 * 13, ≤20 characters). The tapped one comes back with its id as the
 * payload, so the AI's slot buttons work the same way.
 */
export async function instagramEngineSendChoices(
  args: EngineBase & {
    bodyText: string
    buttons?: InteractiveButton[]
    sections?: InteractiveListSection[]
    payload: InteractiveMessagePayload
  },
): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()
  const to = await loadInstagramRecipient(db, args.accountId, args.contactId)
  const choices = [
    ...(args.buttons ?? []).map((b) => ({ title: b.title, payload: b.id })),
    ...(args.sections ?? []).flatMap((s) => s.rows.map((r) => ({ title: r.title, payload: r.id }))),
  ]
  const mids = await deliverInstagramText(to, args.bodyText, choices)
  const body = toInstagramText(args.bodyText)
  await persistBotMessage(
    db,
    args.conversationId,
    {
      content_type: 'interactive',
      content_text: body,
      interactive_payload: args.payload,
      message_id: mids[mids.length - 1] ?? null,
      ai_generated: args.aiGenerated ?? false,
    },
    body,
  )
  return { whatsapp_message_id: mids[mids.length - 1] ?? '' }
}

/** "Seen" plus, optionally, "typing…". Best-effort, never throws. */
export async function instagramMarkRead(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; typing?: boolean },
): Promise<void> {
  try {
    const { data: conv } = await db
      .from('conversations')
      .select('contact_id')
      .eq('id', args.conversationId)
      .maybeSingle()
    if (!conv?.contact_id) return
    const to = await loadInstagramRecipient(db, args.accountId, conv.contact_id as string)
    await sendInstagramSenderAction(to.conn.accessToken, to.igsid, 'mark_seen')
    if (args.typing) await sendInstagramSenderAction(to.conn.accessToken, to.igsid, 'typing_on')
  } catch (err) {
    console.warn('[instagram] mark-read failed:', err instanceof Error ? err.message : err)
  }
}
