import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { replyToInstagramComment, sendInstagramPrivateReply } from '@/lib/instagram/api'
import { loadInstagramConnection } from '@/lib/instagram/connection'
import { findOrCreateContact, findOrCreateConversation } from '@/lib/instagram/contacts'
import { toInstagramText } from '@/lib/instagram/format'
import { instagramGuard } from '@/lib/instagram/page-api'
import { rememberSentMid } from '@/lib/instagram/send'

// A teammate answers a comment by hand. `public` posts a reply under it;
// `private` sends its one private DM (only if none went yet, within 7
// days of the comment) and opens the conversation in the inbox.
// Agents and up.

const PRIVATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const MESSAGED = ['sent', 'awaiting_tap', 'delivered', 'manual']

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await instagramGuard('agent')
  if ('response' in guard) return guard.response
  const { ctx } = guard
  const { id } = await params
  const body = (await request.json().catch(() => null)) as { mode?: unknown; text?: unknown } | null
  const mode = body?.mode === 'private' ? 'private' : body?.mode === 'public' ? 'public' : null
  const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 1000) : ''
  if (!mode || !text) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })

  const admin = supabaseAdmin()
  const { data: comment } = await admin
    .from('instagram_comments')
    .select('id, comment_id, igsid, username, dm_status, created_at')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (!comment) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const conn = await loadInstagramConnection(admin, ctx.accountId)
  if (!conn) return NextResponse.json({ error: 'not_connected' }, { status: 409 })
  const now = new Date().toISOString()

  try {
    if (mode === 'public') {
      const replyId = await replyToInstagramComment(conn.accessToken, comment.comment_id as string, text)
      await admin
        .from('instagram_comments')
        .update({ public_reply_text: text, public_reply_id: replyId, status: 'replied', updated_at: now })
        .eq('id', id)
      return NextResponse.json({ ok: true })
    }

    if (MESSAGED.includes((comment.dm_status as string | null) ?? '')) {
      return NextResponse.json({ error: 'already_messaged' }, { status: 409 })
    }
    if (Date.now() - new Date(comment.created_at as string).getTime() > PRIVATE_WINDOW_MS) {
      return NextResponse.json({ error: 'too_old' }, { status: 409 })
    }
    const sent = toInstagramText(text).slice(0, 1000)
    const result = await sendInstagramPrivateReply(conn.accessToken, comment.comment_id as string, { kind: 'text', text: sent })
    rememberSentMid(result.mid)
    const igsid = result.recipientId || (comment.igsid as string)
    const contact = await findOrCreateContact(admin, conn, igsid, comment.username as string | null)
    const conv = contact ? await findOrCreateConversation(admin, conn, contact.contact.id) : null
    if (conv) {
      await admin.from('messages').insert({
        conversation_id: conv.conversation.id,
        sender_type: 'agent',
        sender_id: ctx.userId,
        status: 'sent',
        content_type: 'text',
        content_text: sent,
        message_id: result.mid || null,
      })
      await admin
        .from('conversations')
        .update({ last_message_text: sent, last_message_at: now, updated_at: now })
        .eq('id', conv.conversation.id)
    }
    await admin
      .from('instagram_comments')
      .update({
        dm_status: 'manual',
        dm_error: null,
        status: 'replied',
        contact_id: contact?.contact.id ?? null,
        conversation_id: conv?.conversation.id ?? null,
        updated_at: now,
      })
      .eq('id', id)
    return NextResponse.json({ ok: true, conversationId: conv?.conversation.id ?? null })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 502 })
  }
}
