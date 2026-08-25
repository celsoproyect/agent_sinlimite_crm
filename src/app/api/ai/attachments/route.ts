import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { listAttachments } from '@/lib/ai/attachments'

/**
 * GET /api/ai/attachments
 *
 * List the account's attachment catalog (any member).
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const attachments = await listAttachments(supabase, accountId)
    return NextResponse.json({ attachments })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/attachments  (admin+)
 *
 * Register a catalog entry. The file itself is already uploaded to the
 * `chat-media` bucket by the client (reusing `uploadAccountMedia`, same as
 * the message composer) — this only stores the metadata + resulting URL.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-attachment:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const description = typeof body?.description === 'string' ? body.description.trim() : ''
    const kind = body?.kind === 'image' || body?.kind === 'document' ? body.kind : ''
    const mediaUrl = typeof body?.mediaUrl === 'string' ? body.mediaUrl.trim() : ''
    const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType.trim() : ''
    // Optional: a catalog entry can be a plain file (no price) or a
    // priced product/service — the send_attachment dispatch (auto-reply.ts)
    // only builds a full product card when price is set.
    const price =
      typeof body?.price === 'number' && Number.isFinite(body.price) && body.price >= 0
        ? body.price
        : null
    const currency = typeof body?.currency === 'string' ? body.currency.trim() || null : null
    if (!name || !description || !kind || !mediaUrl || !filename || !mimeType) {
      return NextResponse.json(
        { error: 'name, description, kind, mediaUrl, filename and mimeType are required' },
        { status: 400 },
      )
    }

    const { data, error } = await supabase
      .from('ai_attachments')
      .insert({
        account_id: accountId,
        created_by: userId,
        name,
        description,
        kind,
        media_url: mediaUrl,
        filename,
        mime_type: mimeType,
        price,
        currency,
      })
      .select('id, name, description, kind, media_url, filename, mime_type, price, currency, updated_at')
      .single()
    if (error || !data) {
      console.error('[ai/attachments POST] insert error:', error)
      return NextResponse.json({ error: 'Failed to create attachment' }, { status: 500 })
    }
    return NextResponse.json({
      attachment: {
        id: data.id,
        name: data.name,
        description: data.description,
        kind: data.kind,
        mediaUrl: data.media_url,
        filename: data.filename,
        mimeType: data.mime_type,
        price: data.price ?? undefined,
        currency: data.currency ?? undefined,
        updatedAt: data.updated_at,
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
