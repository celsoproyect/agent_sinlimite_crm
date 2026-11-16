import { NextResponse } from 'next/server'
import { accountModuleEnabled } from '@/lib/modules-server'
import { instagramDbError, instagramGuard } from '@/lib/instagram/page-api'
import { linkProblem, parseLinkInput, type InstagramLink } from '@/lib/instagram/links'

// Edit or delete one campaign link (admins, module instagram_links).

async function adminGuard() {
  const guard = await instagramGuard('admin')
  if ('response' in guard) return guard
  if (!(await accountModuleEnabled(guard.ctx.supabase, guard.ctx.accountId, 'instagram_links'))) {
    return { response: NextResponse.json({ error: 'module_disabled' }, { status: 403 }) }
  }
  return guard
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await adminGuard()
  if ('response' in guard) return guard.response
  const { ctx } = guard
  const { id } = await params
  const parsed = parseLinkInput(await request.json().catch(() => null), true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data: current, error: readErr } = await ctx.supabase
    .from('instagram_links')
    .select('*')
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (readErr) return instagramDbError(readErr)
  if (!current) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const problem = linkProblem({ ...(current as InstagramLink), ...parsed.input })
  if (problem) return NextResponse.json({ error: problem }, { status: 400 })

  const { data, error } = await ctx.supabase
    .from('instagram_links')
    .update({ ...parsed.input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('*')
  if (error) {
    if (error.code === '23505') return NextResponse.json({ error: 'code_taken' }, { status: 409 })
    return instagramDbError(error)
  }
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ link: data[0] })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await adminGuard()
  if ('response' in guard) return guard.response
  const { ctx } = guard
  const { id } = await params
  const { data, error } = await ctx.supabase
    .from('instagram_links')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')
  if (error) return instagramDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
