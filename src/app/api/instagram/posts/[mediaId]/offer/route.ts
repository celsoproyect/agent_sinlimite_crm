import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { instagramDbError, instagramGuard, parseOfferInput } from '@/lib/instagram/page-api'

// PATCH /api/instagram/posts/[mediaId]/offer (migration 082, admin): the
// post's offer (text, link, catalog item, file, last valid day) and
// whether the AI answers its comments. instagram_posts is select-only
// under RLS, so the write goes through the service role after the guard.

export async function PATCH(request: Request, { params }: { params: Promise<{ mediaId: string }> }) {
  const guard = await instagramGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard
  const { mediaId } = await params
  if (!/^\d{5,40}$/.test(mediaId)) return NextResponse.json({ error: 'invalid_media' }, { status: 400 })

  const parsed = parseOfferInput(await request.json().catch(() => null))
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const db = supabaseAdmin()
  if (parsed.input.offer_catalog_item_id) {
    const { data: item } = await db
      .from('ai_attachments')
      .select('id')
      .eq('id', parsed.input.offer_catalog_item_id as string)
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (!item) return NextResponse.json({ error: 'invalid_catalog_item_id' }, { status: 400 })
  }
  const { data, error } = await db
    .from('instagram_posts')
    .update(parsed.input)
    .eq('account_id', ctx.accountId)
    .eq('media_id', mediaId)
    .select('media_id')
  if (error) return instagramDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
