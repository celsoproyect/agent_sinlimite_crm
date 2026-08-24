import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

type Params = { params: Promise<{ id: string }> }

/**
 * PATCH /api/ai/knowledge-bases/[id]  (admin+) — rename / redescribe.
 */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`ai-kb-collection:${userId}`, RATE_LIMITS.adminAction)
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
      .from('ai_knowledge_bases')
      .update(update)
      .eq('account_id', accountId)
      .eq('id', id)
      .select('id, name, description, updated_at')
      .maybeSingle()
    if (error) {
      console.error('[ai/knowledge-bases/[id] PATCH] error:', error)
      return NextResponse.json(
        { error: 'Failed to update knowledge base' },
        { status: 500 },
      )
    }
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    return NextResponse.json({ knowledgeBase: updated })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/knowledge-bases/[id]  (admin+) — documents + chunks
 * cascade via the FK.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { id } = await params
    const { error } = await supabase
      .from('ai_knowledge_bases')
      .delete()
      .eq('account_id', accountId)
      .eq('id', id)
    if (error) {
      console.error('[ai/knowledge-bases/[id] DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete knowledge base' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
