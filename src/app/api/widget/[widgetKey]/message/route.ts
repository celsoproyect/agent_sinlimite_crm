import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { generateWidgetReply } from '@/lib/ai/widget-reply'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { isSyntheticPhone, mintSyntheticPhone } from '@/lib/contacts/synthetic-phone'

// ============================================================
// POST /api/widget/[widgetKey]/message
//
// The public, unauthenticated endpoint behind the embeddable web
// widget (see /widget.js and the Settings → "Widget web" panel that
// hands a client their embed snippet). A website visitor's message
// comes in, the account's AI agent replies, and the reply goes back
// in the SAME HTTP response — no polling, no realtime subscription
// for an anonymous caller to authenticate against. If a human later
// takes the thread over in the inbox, that reply currently only shows
// up there (documented v1 limitation, same as booking/attachments —
// see widget-reply.ts).
//
// `widgetKey` is deliberately NOT `api_keys` (026): it's a plaintext,
// low-privilege public value (see migration 049's header) whose only
// power is this one action, scoped to one account.
// ============================================================

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: CORS_HEADERS })
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

const WIDGET_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const MAX_MESSAGE_LENGTH = 4000

export async function POST(
  request: Request,
  { params }: { params: Promise<{ widgetKey: string }> },
): Promise<NextResponse> {
  const { widgetKey } = await params
  if (!WIDGET_KEY_RE.test(widgetKey)) {
    return json({ error: 'Not found' }, 404)
  }

  const db = supabaseAdmin()

  const { data: account, error: accountErr } = await db
    .from('accounts')
    .select('id, owner_user_id, widget_enabled')
    .eq('widget_key', widgetKey)
    .maybeSingle()

  if (accountErr) {
    console.error('[widget message] account lookup failed:', accountErr)
    return json({ error: 'Internal server error' }, 500)
  }
  if (!account || !account.widget_enabled) {
    return json({ error: 'Not found' }, 404)
  }

  let body: { visitorId?: unknown; text?: unknown; visitorName?: unknown }
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!text) return json({ error: 'text is required' }, 400)
  if (text.length > MAX_MESSAGE_LENGTH) {
    return json({ error: `text must be ${MAX_MESSAGE_LENGTH} characters or fewer` }, 400)
  }
  const visitorName =
    typeof body.visitorName === 'string' && body.visitorName.trim()
      ? body.visitorName.trim().slice(0, 120)
      : null

  // The visitor identity (and therefore the rate-limit bucket) is
  // resolved before the limit check so a brand-new visitor and a
  // returning one are throttled on the same footing.
  const visitorPhone = isSyntheticPhone(body.visitorId) ? body.visitorId : mintSyntheticPhone()

  const limit = checkRateLimit(`widget:${widgetKey}:${visitorPhone}`, RATE_LIMITS.widgetMessage)
  if (!limit.success) {
    return json(
      { error: 'Rate limit exceeded', retry_after_seconds: Math.ceil((limit.reset - Date.now()) / 1000) },
      429,
    )
  }

  try {
    const contact = await findOrCreateWidgetContact(db, account.id, account.owner_user_id, visitorPhone, visitorName)
    const conversationId = await findOrCreateWidgetConversation(db, account.id, account.owner_user_id, contact.id)

    const { error: insertErr } = await db.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'customer',
      content_type: 'text',
      content_text: text,
      status: 'delivered',
    })
    if (insertErr) throw insertErr

    const { error: bumpErr } = await db.rpc('bump_conversation_on_inbound', {
      p_conversation_id: conversationId,
      p_last_message_text: text,
    })
    if (bumpErr) console.error('[widget message] bump_conversation_on_inbound failed:', bumpErr)

    const reply = await generateWidgetReply({ db, accountId: account.id, conversationId })

    return json({
      visitorId: visitorPhone,
      conversationId,
      reply: reply.ok ? reply.text : null,
      status: reply.ok ? 'ok' : reply.reason,
    })
  } catch (err) {
    console.error('[widget message] failed:', err)
    return json({ error: 'Internal server error' }, 500)
  }
}

async function findOrCreateWidgetContact(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  ownerUserId: string,
  phone: string,
  visitorName: string | null,
) {
  const { data: existing } = await db
    .from('contacts')
    .select('id, name')
    .eq('account_id', accountId)
    .eq('phone', phone)
    .maybeSingle()
  if (existing) return existing

  const { data: created, error } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone,
      name: visitorName || 'Visitante web',
    })
    .select('id, name')
    .single()

  if (error) {
    // Lost a race with a concurrent first message from the same brand-new
    // visitor (two tabs opened at once) — re-resolve instead of failing.
    if (isUniqueViolation(error)) {
      const { data: raced } = await db
        .from('contacts')
        .select('id, name')
        .eq('account_id', accountId)
        .eq('phone', phone)
        .maybeSingle()
      if (raced) return raced
    }
    throw error
  }
  return created
}

async function findOrCreateWidgetConversation(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  ownerUserId: string,
  contactId: string,
): Promise<string> {
  const { data: existingRows } = await db
    .from('conversations')
    .select('id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1)
  if (existingRows && existingRows.length > 0) return existingRows[0].id

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      channel: 'web',
    })
    .select('id')
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await db
        .from('conversations')
        .select('id')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) return raced[0].id
    }
    throw error
  }
  return created.id
}
