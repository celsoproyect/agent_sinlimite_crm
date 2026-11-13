import { NextResponse } from 'next/server'
import { instagramDbError, instagramGuard, isMissingInstagramSchema } from '@/lib/instagram/page-api'

// The comment log: every comment received and what the system did with it.
// ?status=replied|no_match|skipped|error, ?media=<media_id>. Any member.
export async function GET(request: Request) {
  const guard = await instagramGuard('viewer')
  if ('response' in guard) return guard.response
  const { ctx } = guard
  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  const media = url.searchParams.get('media')

  let query = ctx.supabase
    .from('instagram_comments')
    .select(
      'id, comment_id, media_id, parent_id, igsid, username, text, rule_id, status, public_reply_text, dm_status, dm_error, contact_id, conversation_id, created_at',
    )
    .eq('account_id', ctx.accountId)
    .order('created_at', { ascending: false })
    .limit(300)
  if (status && /^[a-z_]{2,20}$/.test(status)) query = query.eq('status', status)
  if (media && /^\d{5,40}$/.test(media)) query = query.eq('media_id', media)

  const { data, error } = await query
  if (error) {
    if (isMissingInstagramSchema(error.code)) return NextResponse.json({ migrated: false, comments: [] })
    return instagramDbError(error)
  }
  return NextResponse.json({ migrated: true, comments: data ?? [] })
}
