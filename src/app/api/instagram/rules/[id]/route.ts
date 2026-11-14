import { NextResponse } from 'next/server'
import { keywordConflicts, normalizeRule } from '@/lib/instagram/keywords'
import { instagramDbError, instagramGuard, parseRuleInput, ruleProblem } from '@/lib/instagram/page-api'

// One keyword rule: edit or delete (admins).

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await instagramGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard
  const { id } = await params

  const parsed = parseRuleInput(await request.json().catch(() => null), true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data: all, error: allErr } = await ctx.supabase
    .from('instagram_keyword_rules')
    .select('*')
    .eq('account_id', ctx.accountId)
  if (allErr) return instagramDbError(allErr)
  const rules = ((all ?? []) as Record<string, unknown>[]).map(normalizeRule)
  const current = rules.find((r) => r.id === id)
  if (!current) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const next = normalizeRule({ ...current, ...parsed.input })
  const problem = ruleProblem(next)
  if (problem) return NextResponse.json({ error: problem }, { status: 400 })
  const conflicts = keywordConflicts(next, rules)
  if (conflicts.length > 0) return NextResponse.json({ error: 'keyword_conflict', conflicts }, { status: 409 })

  const { data, error } = await ctx.supabase
    .from('instagram_keyword_rules')
    .update({ ...parsed.input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('*')
  if (error) return instagramDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ rule: normalizeRule(data[0] as Record<string, unknown>) })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const guard = await instagramGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard
  const { id } = await params
  const { data, error } = await ctx.supabase
    .from('instagram_keyword_rules')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select('id')
  if (error) return instagramDbError(error)
  if (!data?.length) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  return NextResponse.json({ ok: true })
}
