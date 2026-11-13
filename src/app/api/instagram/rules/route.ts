import { NextResponse } from 'next/server'
import { keywordConflicts, type KeywordRule } from '@/lib/instagram/keywords'
import { instagramDbError, instagramGuard, parseRuleInput } from '@/lib/instagram/page-api'

// Create a keyword rule (admins). The same keyword twice in one scope
// (the same post, or both general) answers 409 keyword_conflict.
export async function POST(request: Request) {
  const guard = await instagramGuard('admin')
  if ('response' in guard) return guard.response
  const { ctx } = guard

  const parsed = parseRuleInput(await request.json().catch(() => null), false)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })

  const { data: others, error: othersErr } = await ctx.supabase
    .from('instagram_keyword_rules')
    .select('id, media_id, keywords, match_any, active, name')
    .eq('account_id', ctx.accountId)
  if (othersErr) return instagramDbError(othersErr)
  const candidate = { id: '', ...parsed.input } as unknown as KeywordRule
  const conflicts = keywordConflicts(candidate, (others ?? []) as KeywordRule[])
  if (conflicts.length > 0) return NextResponse.json({ error: 'keyword_conflict', conflicts }, { status: 409 })

  const { data, error } = await ctx.supabase
    .from('instagram_keyword_rules')
    .insert({ account_id: ctx.accountId, ...parsed.input })
    .select('*')
    .single()
  if (error) return instagramDbError(error)
  return NextResponse.json({ rule: data }, { status: 201 })
}
