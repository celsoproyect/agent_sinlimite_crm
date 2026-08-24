import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ id: string }> }

/**
 * PATCH /api/ai/attachments/[id]  (admin+) — rename / redescribe.
 * Swapping the file itself is out of scope: delete + re-add instead.
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
    if (name === undefined && description === undefined) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    if (name !== undefined && !name) {
      return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 })
    }
    if (description !== undefined && !description) {
      return NextResponse.json({ error: 'description cannot be empty' }, { status: 400 })
    }

    const update: Record<string, string> = {}
    if (name !== undefined) update.name = name
    if (description !== undefined) update.description = description

    const { data: updated, error } = await supabase
      .from('ai_attachments')
      .update(update)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id, name, description, kind, media_url, filename, mime_type, updated_at')
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
