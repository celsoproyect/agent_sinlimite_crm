import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ id: string }> }

/**
 * PATCH /api/ai/attachments/[id]  (admin+) — edit any field, including
 * swapping the underlying file. The file itself is already uploaded to
 * the `chat-media` bucket by the client (reusing `uploadAccountMedia`) —
 * this only stores the metadata + resulting URL, same division of labor
 * as POST.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-attachment:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const { id } = await params
    const body = await request.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : undefined
    const description =
      typeof body?.description === 'string' ? body.description.trim() : undefined
    // price/currency are nullable — `null` clears them (a product going
    // back to a plain catalog file), `undefined` leaves them untouched.
    const price =
      body?.price === null
        ? null
        : typeof body?.price === 'number' && Number.isFinite(body.price) && body.price >= 0
          ? body.price
          : undefined
    const currency =
      body?.currency === null
        ? null
        : typeof body?.currency === 'string'
          ? body.currency.trim() || null
          : undefined
    // Replacing the file is all-or-nothing: these four describe one
    // coherent object, so a partial set (e.g. a new mediaUrl but the old
    // mimeType) would desync the row from the actual uploaded blob.
    const kind = body?.kind === 'image' || body?.kind === 'document' ? body.kind : undefined
    const mediaUrl = typeof body?.mediaUrl === 'string' ? body.mediaUrl.trim() : undefined
    const filename = typeof body?.filename === 'string' ? body.filename.trim() : undefined
    const mimeType = typeof body?.mimeType === 'string' ? body.mimeType.trim() : undefined
    const fileFields = [kind, mediaUrl, filename, mimeType]
    const anyFileField = fileFields.some((f) => f !== undefined)
    const allFileFields = fileFields.every((f) => f !== undefined && f !== '')
    if (anyFileField && !allFileFields) {
      return NextResponse.json(
        { error: 'kind, mediaUrl, filename and mimeType must all be provided together' },
        { status: 400 },
      )
    }
    if (
      name === undefined &&
      description === undefined &&
      price === undefined &&
      currency === undefined &&
      !allFileFields
    ) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    if (name !== undefined && !name) {
      return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    }
    if (description !== undefined && !description) {
      return NextResponse.json({ error: 'description cannot be empty' }, { status: 400 })
    }

    const update: Record<string, string | number | null> = {}
    if (name !== undefined) update.name = name
    if (description !== undefined) update.description = description
    if (price !== undefined) update.price = price
    if (currency !== undefined) update.currency = currency
    if (allFileFields) {
      update.kind = kind as string
      update.media_url = mediaUrl as string
      update.filename = filename as string
      update.mime_type = mimeType as string
    }

    const { data: updated, error } = await supabase
      .from('ai_attachments')
      .update(update)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id, name, description, kind, media_url, filename, mime_type, price, currency, updated_at')
      .maybeSingle()
    if (error) {
      console.error('[ai/attachments/[id] PATCH] error:', error)
      return NextResponse.json({ error: 'Failed to update attachment' }, { status: 500 })
    }
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({
      attachment: {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        kind: updated.kind,
        mediaUrl: updated.media_url,
        filename: updated.filename,
        mimeType: updated.mime_type,
        price: updated.price ?? undefined,
        currency: updated.currency ?? undefined,
        updatedAt: updated.updated_at,
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/attachments/[id]  (admin+) — catalog entry only; the
 * underlying `chat-media` blob is left in place, same as message media.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase
      .from('ai_attachments')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[ai/attachments/[id] DELETE] error:', error)
      return NextResponse.json({ error: 'Failed to delete attachment' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
